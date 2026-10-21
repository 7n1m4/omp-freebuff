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
  const stored = dataOrNull(json)?.prompt;
  return typeof stored === "string" && (stored === prompt || stored.endsWith(prompt));
}

// The data payload convention: protocol fields live under `data` with the
// top-level field as the fallback. dataOrNull preserves the missing case.
const dataOrNull = (json: Record<string, unknown>): Record<string, unknown> | null =>
  typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : null;

// The answer key read across data-then-top-level: one convention, shared by
// the turn-end scan and the cancel partial, so the two cannot drift.
const responseOf = (json: Record<string, unknown>): string | null => {
  const data = dataOrNull(json);
  return typeof data?.[FULL_RESPONSE_KEY] === "string"
    ? (data[FULL_RESPONSE_KEY] as string)
    : typeof json[FULL_RESPONSE_KEY] === "string"
      ? (json[FULL_RESPONSE_KEY] as string)
      : null;
};

// shouldEndTurn read across top-level-then-data, matching responseOf.
const endFlagOf = (json: Record<string, unknown>, value: boolean): boolean => {
  const data = dataOrNull(json);
  return json[SHOULD_END_TURN_KEY] === value || data?.[SHOULD_END_TURN_KEY] === value;
};

// The answer sits on the nearest earlier shouldEndTurn line; with none found
// the turn still ends, answerless — the caller turns that into no_answer.
function completionAt(lines: JsonLine[], i: number): TurnEndResult {
  for (let j = i - 1; j >= 0; j--) {
    const prev = lines[j].json;
    if (prev === null || !endFlagOf(prev, true)) continue;
    return { done: true, answer: responseOf(prev) };
  }
  return { done: true, answer: null };
}

// The partial answer of a cancelled Turn: the LAST unfinished-step line
// (shouldEndTurn:false) that carries a fullResponse, so the stop keeps the
// current step's report. No unfinished step reads as null.
export function partialAnswer(logText: string): string | null {
  const lines = logLines(logText);
  for (let i = lines.length - 1; i >= 0; i--) {
    const json = lines[i].json;
    if (json === null || !endFlagOf(json, false)) continue;
    const answer = responseOf(json);
    if (answer !== null) return answer;
  }
  return null;
}

// The Turn's dirs: the baseline dir plus every dir newer than it (freebuff
// rotates dirs per chat); older dirs never carry this Turn's lines. With no
// baseline dir on record, the whole store. Callers keep their own scan order.
export function turnDirs(
  snapshots: ChatDirSnapshot[],
  baseline: TurnBaseline | null,
): { base: ChatDirSnapshot | null; dirs: ChatDirSnapshot[] } {
  const base = baseline === null ? null : (snapshots.find((s) => s.dirName === baseline.dirName) ?? null);
  return { base, dirs: snapshots.filter((s) => base === null || s === base || byNewest(s, base) < 0) };
}

// The verbatim text of one dir's complete log lines at or after the byte
// offset: the archive's slice of this Turn's log. A trailing fragment without
// a newline is not a line yet and stays out.
export function logSince(snap: ChatDirSnapshot, fromBytes: number): string {
  const text = snap.logText;
  const lines = logLines(text);
  const first = lines.find((line) => line.byteStart >= fromBytes);
  if (first === undefined) return "";
  const last = lines[lines.length - 1];
  return text.slice(first.start, text.indexOf("\n", last.start) + 1);
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

// Turn end = the first `Main prompt finished` line at or after the baseline;
// newer chat dirs are scanned from zero.
export function detectTurnEnd(snapshots: ChatDirSnapshot[], baseline: TurnBaseline): TurnEndResult {
  const { base, dirs } = turnDirs(snapshots, baseline);
  if (base !== null) {
    const hit = scanDir(base, baseline.logBytes);
    if (hit) return hit;
  }
  for (const snap of dirs.filter((s) => s !== base).sort(byNewest)) {
    const hit = scanDir(snap, 0);
    if (hit) return hit;
  }
  return { done: false, answer: null };
}

// The per-step progress feed (story 14). freebuff logs one DEBUG line per agent
// step — `End agent <id> step N` (re-verified on 0.2.29) — whose data carries the
// step's tool calls, tool results and the running fullResponse. Only the shapes
// the feed reads are pinned; level and agent id are ignored.
export type StepFeed = {
  step: number;
  lastToolCall?: string;
  lastToolResult?: string;
  partialAnswer?: string;
};

const STEP_END_REGEX = /^End agent \S+ step (\d+)/;
const TOOL_CALLS_KEY = "toolCalls";
const TOOL_RESULTS_KEY = "toolResults";

const lastToolName = (data: Record<string, unknown>, key: string): string | undefined => {
  const entries = data[key];
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).toolName === "string") {
      return (entry as Record<string, unknown>).toolName as string;
    }
  }
  return undefined;
};

// The newest `End agent ... step N` line at or after the baseline, read in
// chronological order (the baseline's tail, then newer dirs oldest first); a
// store with no step line yet reads as null.
export function stepFeedSince(snapshots: ChatDirSnapshot[], baseline: TurnBaseline): StepFeed | null {
  const { base, dirs } = turnDirs(snapshots, baseline);
  const newer = dirs.filter((s) => s !== base).sort((a, b) => byNewest(b, a));
  const found: { step: number; data: Record<string, unknown> | null } = { step: 0, data: null };
  const scan = (snap: ChatDirSnapshot, from: number): void => {
    for (const line of logLines(snap.logText)) {
      if (line.byteStart < from || line.json === null) continue;
      const match = STEP_END_REGEX.exec(String(line.json[MSG_KEY] ?? ""));
      if (match === null) continue;
      found.step = Number(match[1]);
      found.data = dataOrNull(line.json) ?? line.json;
    }
  };
  if (base !== null) scan(base, baseline.logBytes);
  for (const snap of newer) scan(snap, 0);
  if (found.step === 0 || found.data === null) return null;
  const feed: StepFeed = { step: found.step };
  const lastCall = lastToolName(found.data, TOOL_CALLS_KEY);
  if (lastCall !== undefined) feed.lastToolCall = lastCall;
  const lastResult = lastToolName(found.data, TOOL_RESULTS_KEY);
  if (lastResult !== undefined) feed.lastToolResult = lastResult;
  const response = found.data[FULL_RESPONSE_KEY];
  if (typeof response === "string" && response.length > 0) feed.partialAnswer = response;
  return feed;
}

// The rendered chat store's block count for one chat dir: chat-messages.json is
// rewritten atomically, so a torn read parses as null and the next poll re-reads.
export function renderedBlockCount(configDir: string, dir: string, dirName: string): number | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(configDir, PROJECTS_DIRNAME, projectKey(dir), CHATS_DIRNAME, dirName, "chat-messages.json"), "utf8"),
    );
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}
