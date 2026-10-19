// The Task archive: one directory per settle under <pluginDir>/tasks/, written
// success included (ADR-0003). A write only ever creates a fresh directory; an
// existing archive is never deleted, rewritten or pruned.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./turnRunner";

export interface TaskArchiveInput {
  pluginDir: string;
  /** Submit-time Task id; pins the directory name. Absent: a stamp id is generated. */
  taskId?: string;
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
  /** Absent writes nothing: the abandoned archive (#23) is meta-only. */
  answer?: string;
  chatMessages?: string;
  screen?: string;
  stderr?: string;
}

// The stamp is a fixed 18 chars (date 8 + 'T' + time 6 + milliseconds 3, the
// ISO-8601 UTC form minus '-', ':', '.', 'Z'), so ids sort lexicographically in
// chronological order.
export function nextTaskId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.Z]/g, "");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function writeTaskArchive(input: TaskArchiveInput): { taskId: string; archivePath: string } {
  const taskId = input.taskId ?? nextTaskId(input.now);
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
  // An absent input writes no file at all (the abandoned archive is meta-only);
  // a present empty string writes the empty file, as settle always has.
  if (input.answer !== undefined) writeFileSync(join(archivePath, "answer.md"), input.answer);
  if (input.chatMessages !== undefined) writeFileSync(join(archivePath, "chat-messages.json"), input.chatMessages);
  if (input.screen !== undefined) writeFileSync(join(archivePath, "screen.txt"), input.screen);
  // Only when non-empty; never a zero-byte placeholder.
  if (input.stderr !== undefined && input.stderr !== "") writeFileSync(join(archivePath, "stderr.log"), input.stderr);
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

// Read-time Abandoned inference (#23): an archive is Abandoned iff its verdict
// is null and no done@ tombstone landed. The flag is stored nowhere; there is
// no tenth Verdict; so a hard kill (nothing ran, no tombstone, verdict null)
// and a graceful teardown report identically. A torn write leaves no readable
// verdict and is skipped: status must survive it.
export interface AbandonedTaskReport {
  taskId: string;
  prompt: string;
  target: string;
  phase: string;
  diedAt: string;
}

export function readAbandonedTasks(pluginDir: string): AbandonedTaskReport[] {
  let names: string[];
  try {
    names = readdirSync(join(pluginDir, "tasks"));
  } catch {
    return [];
  }
  const reports: AbandonedTaskReport[] = [];
  for (const taskId of names.sort()) {
    let meta: { prompt?: unknown; target?: unknown; verdict?: unknown; phaseLog?: unknown };
    try {
      meta = JSON.parse(readFileSync(join(pluginDir, "tasks", taskId, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    if (meta.verdict !== null) continue;
    const phaseLog = Array.isArray(meta.phaseLog)
      ? meta.phaseLog.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (phaseLog.some((entry) => entry.startsWith("done@"))) continue;
    // The tombstone only marks death; the phase is where the Task last lived.
    const lastLived = phaseLog.filter((entry) => !entry.startsWith("abandoned@")).at(-1);
    const at = lastLived === undefined ? -1 : lastLived.indexOf("@");
    const tombstone = phaseLog.find((entry) => entry.startsWith("abandoned@"));
    // diedAt: the tombstone's stamp, else the last entry's, else "".
    const stampEntry = tombstone ?? phaseLog.at(-1);
    reports.push({
      taskId,
      prompt: typeof meta.prompt === "string" ? meta.prompt : "",
      target: typeof meta.target === "string" ? meta.target : "",
      phase: lastLived === undefined ? "" : at === -1 ? lastLived : lastLived.slice(0, at),
      diedAt: stampEntry === undefined ? "" : stampEntry.slice(stampEntry.indexOf("@") + 1),
    });
  }
  return reports;
}
