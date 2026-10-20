// freebuff_status: the Lock's state, the Instance pid, the current junction Target,
// freebuff's own live-slot records and the Task archive summary, so a human sees
// who holds the account's slot (ADR-0001). The Hour-session minutes and the
// screen-drift flag come from the same reads; nothing here is a placeholder.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classifyLock,
  pidAlive,
  readLock,
  type LockDeps,
  type LockKind,
  type LockState,
} from "./lock";
import { archiveSummary, readAbandonedTasks, type AbandonedTaskReport } from "./archive";
import { corpusVersions } from "./protocol/corpus";
import { hasUnrecognizedDump, metadataVersion } from "./protocol/screenDump";
import { readJunctionTarget, workspaceDir } from "./workspace";

export function defaultFreebuffConfigDir(): string {
  return join(homedir(), ".config", "manicode");
}

export interface ForeignDeps extends Pick<LockDeps, "now" | "isPidAlive"> {
  ownInstancePid?: number;
}

// One reader for freebuff's freebuff-live-*.json records: the parsed objects,
// with torn, malformed or non-object files skipped. Watched, never trusted as
// a guard; nothing here kills. readForeignHolders filters these down to the
// foreign live holders; the turn runner reads our own instance's record for
// its model.
export function readLiveRecords(freebuffConfigDir: string): { ownerPid?: unknown; model?: unknown; expiresAt?: unknown }[] {
  let names: string[];
  try {
    names = readdirSync(freebuffConfigDir);
  } catch {
    return [];
  }
  const records: { ownerPid?: unknown; model?: unknown; expiresAt?: unknown }[] = [];
  for (const name of names) {
    if (!name.startsWith("freebuff-live-") || !name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(freebuffConfigDir, name), "utf8"));
      if (parsed !== null && typeof parsed === "object") records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

// The foreign live holders: live means the ownerPid is alive and the expiry is
// in the future; our own instance's record is excluded by pid.
export function readForeignHolders(
  freebuffConfigDir: string,
  deps?: ForeignDeps,
): { live: { pid: number; model: string; expiresAt: number }[] } {
  const now = deps?.now ?? Date.now;
  const isPidAlive = deps?.isPidAlive ?? pidAlive;
  const live: { pid: number; model: string; expiresAt: number }[] = [];
  for (const raw of readLiveRecords(freebuffConfigDir)) {
    if (typeof raw.ownerPid !== "number" || typeof raw.model !== "string" || typeof raw.expiresAt !== "number") {
      continue;
    }
    if (raw.ownerPid === deps?.ownInstancePid) continue;
    if (!isPidAlive(raw.ownerPid) || raw.expiresAt <= now()) continue;
    live.push({ pid: raw.ownerPid, model: raw.model, expiresAt: raw.expiresAt });
  }
  return { live };
}

export interface StatusResult {
  lock: {
    state: LockState;
    ownerPid?: number;
    instancePid?: number;
    kind?: LockKind;
    startedAt?: string;
  };
  instancePid?: number;
  target?: string;
  foreign: { live: { pid: number; model: string; expiresAt: number }[] };
  archive: { count: number; totalBytes: number; newestId?: string };
  abandoned: AbandonedTaskReport[];
  /** Minutes left on our own Instance's Hour session, from its per-pid record; undefined without a live record. */
  hourMinutesLeft?: number;
  /** The drift alarm: an unrecognized-frame dump exists for the installed version the shipped corpus does not cover. */
  screenDrift: boolean;
}

export function freebuffStatus(
  opts: {
    pluginDir: string;
    freebuffConfigDir: string;
    instancePid?: number;
    /** Corpus root override for tests; defaults to the shipped fixture corpus. */
    corpusDir?: string;
  } & LockDeps,
): StatusResult {
  const record = readLock(opts.pluginDir);
  const lock: StatusResult["lock"] = {
    state: classifyLock(record, {
      now: opts.now,
      isPidAlive: opts.isPidAlive,
      hasLiveTask: opts.hasLiveTask,
    }),
  };
  if (record) {
    lock.ownerPid = record.ownerPid;
    lock.instancePid = record.instancePid ?? undefined;
    lock.kind = record.kind;
    lock.startedAt = record.startedAt;
  }
  // The in-process pid is known even when the record predates the spawn.
  const instancePid = opts.instancePid ?? record?.instancePid ?? undefined;
  const target = readJunctionTarget(workspaceDir(opts.pluginDir));
  // One read pass over freebuff's per-pid records serves both the foreign list
  // and our own Instance's Hour-session remainder.
  const liveHolders = readForeignHolders(opts.freebuffConfigDir, {
    now: opts.now,
    isPidAlive: opts.isPidAlive,
  }).live;
  const own = instancePid !== undefined ? liveHolders.find((h) => h.pid === instancePid) : undefined;
  const foreign = liveHolders.filter((h) => h.pid !== instancePid);
  const version = metadataVersion(opts.freebuffConfigDir);
  const now = opts.now ?? Date.now;
  const status: StatusResult = {
    lock,
    foreign: { live: foreign },
    archive: archiveSummary(opts.pluginDir),
    abandoned: readAbandonedTasks(opts.pluginDir),
    screenDrift:
      version !== null &&
      hasUnrecognizedDump(opts.freebuffConfigDir, version) &&
      !corpusVersions(opts.corpusDir).includes(version),
  };
  if (own !== undefined) status.hourMinutesLeft = Math.max(0, Math.ceil((own.expiresAt - now()) / 60_000));
  if (instancePid !== undefined) status.instancePid = instancePid;
  if (target !== undefined) status.target = target;
  return status;
}
