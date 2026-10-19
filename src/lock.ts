// Turn-scoped Lock: the machine-wide record at <pluginDir>/lock.json naming the
// Owner allowed to drive the Instance. Taken before a Task's spawn, deleted when
// the Task yields, on every exit path. See ADR-0001; the third staleness
// case (own pid, no live Task) is ADR-0004.
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export type LockKind = "extension" | "keeper";

export interface LockRecord {
  ownerPid: number;
  instancePid: number | null;
  kind: LockKind;
  startedAt: string; // ISO
}

// Every call site injects what it can fake; the defaults are the real machine.
export interface LockDeps {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => Promise<void>;
  hasLiveTask?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  deadlineMs?: number;
}

export type LockState = "free" | "self" | "held-by-other" | "stale";

export type ClaimResult =
  | { claimed: true; release: () => void }
  | { claimed: false; busy: true; holder: LockRecord };

// 30 minutes: the 20-minute Task deadline plus spawn/settle slack (ADR-0001).
export const STALE_LOCK_MS = 30 * 60 * 1000;
const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 100;
const KILL_TIMEOUT_MS = 5_000;

const lockPath = (pluginDir: string): string => join(pluginDir, "lock.json");

const realSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is owned by someone else: alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// taskkill /T takes the whole child tree; the poll confirms the pid is really
// gone before any reclaim deletes the record.
export async function killInstance(pid: number): Promise<void> {
  await promisify(execFile)("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (pidAlive(pid) && Date.now() < deadline) await realSleep(DEFAULT_POLL_MS);
  if (pidAlive(pid)) throw new Error(`taskkill failed: pid ${pid} still alive`);
}

export function readLock(pluginDir: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath(pluginDir), "utf8")) as Partial<LockRecord>;
    if (
      typeof raw.ownerPid !== "number" ||
      typeof raw.startedAt !== "string" ||
      (raw.kind !== "extension" && raw.kind !== "keeper")
    ) {
      return null;
    }
    return {
      ownerPid: raw.ownerPid,
      instancePid: typeof raw.instancePid === "number" ? raw.instancePid : null,
      kind: raw.kind,
      startedAt: raw.startedAt,
    };
  } catch {
    return null;
  }
}

export function writeLock(pluginDir: string, record: LockRecord, opts?: { exclusive?: boolean }): void {
  const data = JSON.stringify(record);
  if (opts?.exclusive) {
    // Exclusive create makes the take race-safe: a loser sees EEXIST instead of
    // silently overwriting a record it just classified as free.
    const fd = openSync(lockPath(pluginDir), "wx");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return;
  }
  writeFileSync(lockPath(pluginDir), data);
}

export function setLockInstancePid(pluginDir: string, pid: number): void {
  const record = readLock(pluginDir);
  if (!record) return;
  record.instancePid = pid;
  writeLock(pluginDir, record);
}

export function releaseLock(pluginDir: string): void {
  try {
    rmSync(lockPath(pluginDir), { force: true });
  } catch {
    // Never throws: a lost release race just means the next claim re-classifies.
  }
}

// Stale: over STALE_LOCK_MS old, a dead ownerPid, or our own pid with no live Task
// behind it (an Extension reloaded in place). Reclaimable whatever it claims.
export function classifyLock(
  record: LockRecord | null,
  deps?: Pick<LockDeps, "now" | "isPidAlive" | "hasLiveTask">,
): LockState {
  if (!record) return "free";
  const now = deps?.now ?? Date.now;
  const isPidAlive = deps?.isPidAlive ?? pidAlive;
  const hasLiveTask = deps?.hasLiveTask ?? (() => false);
  if (now() - Date.parse(record.startedAt) > STALE_LOCK_MS) return "stale";
  if (!isPidAlive(record.ownerPid)) return "stale";
  if (record.ownerPid === process.pid && !hasLiveTask()) return "stale";
  return record.ownerPid === process.pid ? "self" : "held-by-other";
}

// Reclaim = kill the recorded Instance if alive, wait it out, then delete the
// record — but only while it is still the one we classified, so a concurrent
// claimer that took the Lock meanwhile never loses its fresh record.
export async function reclaimLock(
  pluginDir: string,
  deps?: Pick<LockDeps, "now" | "isPidAlive" | "killPid" | "sleep" | "pollMs">,
): Promise<void> {
  const now = deps?.now ?? Date.now;
  const isPidAlive = deps?.isPidAlive ?? pidAlive;
  const killPid = deps?.killPid ?? killInstance;
  const doSleep = deps?.sleep ?? realSleep;
  const pollMs = deps?.pollMs ?? DEFAULT_POLL_MS;
  const stale = readLock(pluginDir);
  if (!stale) return;
  if (stale.instancePid !== null && isPidAlive(stale.instancePid)) {
    await killPid(stale.instancePid);
    const deadline = now() + KILL_TIMEOUT_MS;
    while (isPidAlive(stale.instancePid) && now() < deadline) await doSleep(pollMs);
  }
  const current = readLock(pluginDir);
  if (current && current.ownerPid === stale.ownerPid && current.startedAt === stale.startedAt) {
    releaseLock(pluginDir);
  }
}

export async function claimLock(
  pluginDir: string,
  kind: LockKind,
  deps: LockDeps & { deadlineMs: number },
): Promise<ClaimResult> {
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? pidAlive;
  const killPid = deps.killPid ?? killInstance;
  const hasLiveTask = deps.hasLiveTask ?? (() => false);
  const doSleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + deps.deadlineMs;
  for (;;) {
    const record = readLock(pluginDir);
    switch (classifyLock(record, { now, isPidAlive, hasLiveTask })) {
      case "free": {
        try {
          // Our record goes down with instancePid null BEFORE any spawn (ADR-0001).
          writeLock(
            pluginDir,
            { ownerPid: process.pid, instancePid: null, kind, startedAt: new Date(now()).toISOString() },
            { exclusive: true },
          );
          return { claimed: true, release: () => releaseLock(pluginDir) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Lost the take race: fall through to sleep, re-read, re-classify.
        }
        break;
      }
      case "stale":
        await reclaimLock(pluginDir, { now, isPidAlive, killPid, sleep: doSleep, pollMs });
        break;
      default:
        // held-by-other or self with a live Task: wait, never take over a Turn.
        if (now() >= deadline) return { claimed: false, busy: true, holder: record! };
    }
    await doSleep(pollMs);
  }
}

export class LockBusyError extends Error {
  readonly holder: LockRecord;
  readonly busy = true;

  constructor(holder: LockRecord) {
    super(`lock busy: held by pid ${holder.ownerPid} (${holder.kind}) since ${holder.startedAt}`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

export async function withLock<T>(
  pluginDir: string,
  kind: LockKind,
  deps: LockDeps & { deadlineMs?: number },
  fn: (lock: { setInstancePid(pid: number): void }) => Promise<T>,
): Promise<T> {
  const claim = await claimLock(pluginDir, kind, { ...deps, deadlineMs: deps.deadlineMs ?? DEFAULT_DEADLINE_MS });
  if (!claim.claimed) throw new LockBusyError(claim.holder);
  // ONE finally covers every exit path: normal return, throw, reclaim-inside.
  try {
    return await fn({ setInstancePid: (pid) => setLockInstancePid(pluginDir, pid) });
  } finally {
    claim.release();
  }
}
