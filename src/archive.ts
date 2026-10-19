// The Task archive: one directory per settle under <pluginDir>/tasks/, written
// success included (ADR-0003). A write only ever creates a fresh directory; an
// existing archive is never deleted, rewritten or pruned.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./turnRunner";

export interface TaskArchiveInput {
  pluginDir: string;
  /** Settle time: stamps the id, and serves as settledAt in the timings. */
  now: number;
  prompt: string;
  target: string | null;
  model: string | null;
  instancePid: number | null;
  verdict: Verdict | null;
  /** `<phase>@<ISO-8601 UTC>` entries; open list, never validated against the Phase set. */
  phaseLog: string[];
  startedAt: number;
  answer: string;
  chatMessages: string;
  screen: string;
  stderr: string;
}

// The stamp is a fixed 18 chars (date 8 + 'T' + time 6 + milliseconds 3, the
// ISO-8601 UTC form minus '-', ':', '.', 'Z'), so ids sort lexicographically in
// chronological order.
export function nextTaskId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.Z]/g, "");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function writeTaskArchive(input: TaskArchiveInput): { taskId: string; archivePath: string } {
  const taskId = nextTaskId(input.now);
  const archivePath = join(input.pluginDir, "tasks", taskId);
  // A new unique directory per call means a crash mid-write can leave a partial
  // archive but can never corrupt a previous one.
  mkdirSync(archivePath, { recursive: true });
  const meta = {
    id: taskId,
    prompt: input.prompt,
    target: input.target,
    model: input.model,
    instancePid: input.instancePid,
    verdict: input.verdict,
    phaseLog: input.phaseLog,
    timings: { startedAt: input.startedAt, settledAt: input.now, elapsedMs: input.now - input.startedAt },
  };
  writeFileSync(join(archivePath, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(archivePath, "answer.md"), input.answer);
  writeFileSync(join(archivePath, "chat-messages.json"), input.chatMessages);
  writeFileSync(join(archivePath, "screen.txt"), input.screen);
  // Only when non-empty; never a zero-byte placeholder.
  if (input.stderr !== "") writeFileSync(join(archivePath, "stderr.log"), input.stderr);
  return { taskId, archivePath };
}

export function archiveSummary(pluginDir: string): { count: number; totalBytes: number; newestId?: string } {
  const tasksDir = join(pluginDir, "tasks");
  let names: string[];
  try {
    names = readdirSync(tasksDir);
  } catch {
    return { count: 0, totalBytes: 0 };
  }
  let count = 0;
  let totalBytes = 0;
  let newestId: string | undefined;
  for (const name of names) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(join(tasksDir, name)).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    count += 1;
    totalBytes += directorySize(join(tasksDir, name));
    if (newestId === undefined || name > newestId) newestId = name;
  }
  return newestId === undefined ? { count: 0, totalBytes: 0 } : { count, totalBytes, newestId };
}

function directorySize(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.reduce((total, entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return total + directorySize(path);
    try {
      return total + statSync(path).size;
    } catch {
      return total;
    }
  }, 0);
}
