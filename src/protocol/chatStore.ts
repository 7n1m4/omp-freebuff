import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// The chat store's on-disk layout: <configDir>/projects/<projectKey(cwd)>/chats/
// <timestamp>/log.jsonl. An Ack line mentioning the prompt, then the Turn end line
// carrying data.fullResponse. Re-verified on 0.0.199; `~/.freebuff` held per-project
// state only for older builds.
const PROJECTS_DIRNAME = "projects";
const CHATS_DIRNAME = "chats";
const LOG_FILENAME = "log.jsonl";

// Chat-store line keys, kept beside the reader that parses them: the turn-end
// marker line, and the JSON fields the Ack and the answer live on.
const TURN_END_MSG = "Main prompt finished";
const MSG_KEY = "msg";
const FULL_RESPONSE_KEY = "fullResponse";
const SHOULD_END_TURN_KEY = "shouldEndTurn";

// Issue #1: basename-key collisions are accepted; the real app keys chats by plain basename.
export function projectKey(dir: string): string {
  return basename(dir);
}

export type ChatDirSnapshot = { dirName: string; mtimeMs: number; logBytes: number; logText: string };
export type TurnBaseline = { dirName: string; logBytes: number };
export type TurnEndResult = { done: boolean; answer: string | null };

// Reads every chat dir of the store: log mtime, size and text when log.jsonl exists;
// a dir-mtime fallback entry (logBytes 0, empty text) for a chat dir whose log is not
// written yet (the Turn-start race) or cannot be read (e.g. locked mid-write); a
// missing store reads as none.
export function readChats(configDir: string, dir: string): ChatDirSnapshot[] {
  const root = join(configDir, PROJECTS_DIRNAME, projectKey(dir), CHATS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const snaps: ChatDirSnapshot[] = [];
  for (const dirName of names) {
    const logPath = join(root, dirName, LOG_FILENAME);
    try {
      const log = statSync(logPath);
      snaps.push({ dirName, mtimeMs: log.mtimeMs, logBytes: log.size, logText: readFileSync(logPath, "utf8") });
    } catch {
      try {
        const chatDir = statSync(join(root, dirName));
        snaps.push({ dirName, mtimeMs: chatDir.mtimeMs, logBytes: 0, logText: "" });
      } catch {
        // Dir vanished between readdir and stat.
      }
    }
  }
  return snaps;
}

export const byNewest = (a: ChatDirSnapshot, b: ChatDirSnapshot): number =>
  b.mtimeMs - a.mtimeMs || (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0);

// Byte offsets count the UTF-8 bytes of log.jsonl, not code points, so a baseline
// taken from statSync().size never cuts a line in half.
type JsonLine = { start: number; byteStart: number; json: Record<string, unknown> | null };

// Lazy flushes split lines mid-write: a trailing fragment without a newline is
// not a line yet.
function logLines(text: string): JsonLine[] {
  const lines: JsonLine[] = [];
  let byteStart = 0;
  const limit = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
  for (let start = 0; start < limit; ) {
    const nl = text.indexOf("\n", start);
    if (nl < 0 || nl >= limit) break;
    let json: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text.slice(start, nl));
      if (value !== null && typeof value === "object") json = value as Record<string, unknown>;
    } catch {
      // Malformed or half-flushed line: skip silently.
    }
    lines.push({ start, byteStart, json });
    const lineBytes = Buffer.byteLength(text.slice(start, nl), "utf8") + 1;
    byteStart += lineBytes;
    start = nl + 1;
  }
  return lines;
}

export function newestChatDir(dirs: ChatDirSnapshot[]): ChatDirSnapshot | null {
  return dirs.length === 0 ? null : dirs.reduce((newest, d) => (byNewest(d, newest) < 0 ? d : newest));
}

export function hasLineSince(snap: ChatDirSnapshot, fromBytes: number, test: (json: Record<string, unknown>) => boolean): boolean {
  for (const { byteStart, json } of logLines(snap.logText)) {
    if (byteStart >= fromBytes && json !== null && test(json)) return true;
  }
  return false;
}

// Ack shapes seen in the wild: the stub logs the prompt as the msg field; the real app
// nests it under data.prompt on the agent start/end lines. Since the 2026-09 update the
// real app labels bigger bracketed pastes, storing `[Pasted Text]\n` + prompt, so a
// mention is an exact match or a labeled paste carrying the prompt as its tail.
export function lineMentionsPrompt(json: Record<string, unknown>, prompt: string): boolean {
  if (json[MSG_KEY] === prompt) return true;
  const data = typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : null;
  const stored = data?.prompt;
  return typeof stored === "string" && (stored === prompt || stored.endsWith(prompt));
}

// The answer sits on the nearest earlier shouldEndTurn line (its data.fullResponse,
// else the top-level field); with none found the turn still ends, answerless — the
// caller turns that into the no_answer verdict.
function completionAt(lines: JsonLine[], i: number): TurnEndResult {
  for (let j = i - 1; j >= 0; j--) {
    const prev = lines[j].json;
    if (prev === null) continue;
    const data = typeof prev.data === "object" && prev.data !== null ? (prev.data as Record<string, unknown>) : null;
    if (prev[SHOULD_END_TURN_KEY] !== true && data?.[SHOULD_END_TURN_KEY] !== true) continue;
    const answer =
      typeof data?.[FULL_RESPONSE_KEY] === "string"
        ? data[FULL_RESPONSE_KEY]
        : typeof prev[FULL_RESPONSE_KEY] === "string"
          ? prev[FULL_RESPONSE_KEY]
          : null;
    return { done: true, answer };
  }
  return { done: true, answer: null };
}

function scanDir(snap: ChatDirSnapshot, from: number): TurnEndResult | null {
  const lines = logLines(snap.logText);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].byteStart < from) continue;
    if (lines[i].json?.[MSG_KEY] !== TURN_END_MSG) continue;
    return completionAt(lines, i);
  }
  return null;
}

// Turn end = the first `Main prompt finished` line at or after the baseline; a newer
// chat dir (freebuff rotates dirs per chat) is scanned from zero.
export function detectTurnEnd(snapshots: ChatDirSnapshot[], baseline: TurnBaseline): TurnEndResult {
  const base = snapshots.find((s) => s.dirName === baseline.dirName);
  if (base) {
    const hit = scanDir(base, baseline.logBytes);
    if (hit) return hit;
  }
  const newer = base
    ? snapshots.filter((s) => byNewest(s, base) < 0)
    : snapshots.filter((s) => s.dirName !== baseline.dirName);
  for (const snap of newer.sort(byNewest)) {
    const hit = scanDir(snap, 0);
    if (hit) return hit;
  }
  return { done: false, answer: null };
}
