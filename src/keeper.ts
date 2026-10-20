// The scheduled Keeper (ADR-0002): once per allowance day, drive one tiny
// read-only Task so freebuff's Hour-session streak survives. A standalone
// script, never an in-extension daemon: it probes on-disk activity and live
// Instances first, skips when the day already had either, and otherwise claims
// the Lock as kind "keeper", runs one Task, and kills only the Instance it
// started. An Abandoned Task is reported, never resumed.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { archiveSummary, type AbandonedTaskReport } from "./archive";
import { LockBusyError, type LockDeps } from "./lock";
import { readChats } from "./protocol/chatStore";
import { defaultFreebuffConfigDir, freebuffStatus } from "./status";
import { TurnRunner, type TurnRunnerOptions, type Verdict } from "./turnRunner";
import { defaultPluginDir, resolveTarget, workspaceDir } from "./workspace";

export interface KeeperOptions {
  /** lock.json and tasks/ home; defaults to %LOCALAPPDATA%\freebuff-plugin. */
  pluginDir?: string;
  /** Chat-store root probed for activity; defaults to ~/.config/manicode. */
  freebuffConfigDir?: string;
  /** The Instance's cwd; defaults to <pluginDir>/freebuff-ws. */
  workspace?: string;
  /** Where the workspace repo junction points; defaults to the cwd's git root. */
  target?: string;
  /** Spawn command; production uses the freebuff CLI on PATH. */
  command?: { application: string; args?: string[] };
  /** Forwarded to the child. */
  env?: Record<string, string>;
  /** Probe instant; defaults to Date.now(). */
  now?: number;
  /** Liveness knobs for the probe and the Lock claim. */
  lockDeps?: Pick<LockDeps, "isPidAlive" | "killPid" | "hasLiveTask" | "deadlineMs">;
  /** Lock claim wait; a holder that outlasts it skips the run. */
  deadlineMs?: number;
  /** Returns a STARTED driver; tests inject one, production spawns command. */
  createDriver?: TurnRunnerOptions["createDriver"];
  /** PTY timings; defaults suit the real CLI, tests shorten them. */
  timings?: TurnRunnerOptions["timings"];
  /** Progress lines; defaults to console.log. */
  log?: (message: string) => void;
}

export interface KeeperReport {
  action: "spawned" | "skipped";
  reason?: "recent-activity" | "live-instance" | "lock-busy";
  taskId?: string;
  verdict?: Verdict;
  archivePath?: string;
  abandoned: AbandonedTaskReport[];
  /** ISO start of the current allowance day (the most recent 21:00 UTC). */
  windowStart: string;
}

// Freebuff resets the daily allowance at 21:00 UTC: that instant, or yesterday's
// when today's has not arrived yet, opens the activity window.
export function lastAllowanceReset(nowMs: number): number {
  const now = new Date(nowMs);
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21);
  return reset > nowMs ? reset - 86_400_000 : reset;
}

export function keeperPrompt(): string {
  return "In one sentence, what does README.md do? Read only — do not edit anything.";
}

// The newest archive's submit instant. archiveSummary knows only the id; the
// meta carries timings.startedAt. An unreadable archive is not activity.
function newestArchiveStartedAt(pluginDir: string): number | null {
  const { newestId } = archiveSummary(pluginDir);
  if (newestId === undefined) return null;
  try {
    const meta = JSON.parse(readFileSync(join(pluginDir, "tasks", newestId, "meta.json"), "utf8")) as {
      timings?: { startedAt?: unknown };
    };
    return typeof meta.timings?.startedAt === "number" ? meta.timings.startedAt : null;
  } catch {
    return null;
  }
}

export async function runKeeper(options: KeeperOptions = {}): Promise<KeeperReport> {
  const pluginDir = options.pluginDir ?? defaultPluginDir();
  const freebuffConfigDir = options.freebuffConfigDir ?? defaultFreebuffConfigDir();
  const workspace = options.workspace ?? workspaceDir(pluginDir);
  const target = options.target ?? resolveTarget(process.cwd());
  const now = options.now ?? Date.now();
  const windowStart = lastAllowanceReset(now);
  const windowStartIso = new Date(windowStart).toISOString();
  const log = options.log ?? console.log;
  const status = freebuffStatus({
    pluginDir,
    freebuffConfigDir,
    now: () => now,
    isPidAlive: options.lockDeps?.isPidAlive,
    hasLiveTask: options.lockDeps?.hasLiveTask,
  });
  const abandoned = status.abandoned;

  // Any live Instance counts as foreign: no instancePid is passed, so nothing
  // is excluded from freebuff's per-pid live records.
  if (status.foreign.live.length > 0) {
    log(`keeper window ${windowStartIso}: live freebuff instance pid ${status.foreign.live[0].pid}, skip`);
    return { action: "skipped", reason: "live-instance", abandoned, windowStart: windowStartIso };
  }
  const chatActivity = readChats(freebuffConfigDir, workspace).some((chat) => chat.mtimeMs >= windowStart);
  const archiveStartedAt = newestArchiveStartedAt(pluginDir);
  const archiveActivity = archiveStartedAt !== null && archiveStartedAt >= windowStart;
  if (chatActivity || archiveActivity) {
    log(
      `keeper window ${windowStartIso}: activity since the window (${chatActivity ? "chat store" : "archive"}), skip; ` +
        `${abandoned.length} abandoned task(s) on record`,
    );
    return { action: "skipped", reason: "recent-activity", abandoned, windowStart: windowStartIso };
  }
  log(
    `keeper window ${windowStartIso}: no activity; running one read-only task; ` +
      `${abandoned.length} abandoned task(s) reported, none resumed`,
  );

  const runner = new TurnRunner({
    pluginDir,
    workspace,
    freebuffConfigDir,
    command: options.command ?? { application: "freebuff" },
    env: options.env,
    timings: options.timings,
    lockDeps: { ...options.lockDeps, deadlineMs: options.deadlineMs ?? options.lockDeps?.deadlineMs },
    lockKind: "keeper",
    createDriver: options.createDriver,
  });
  try {
    // The junction swap rides the runner, inside the claimed Lock (story 31).
    const outcome = await runner.run(keeperPrompt(), { target });
    const taskId = outcome.archivePath === undefined ? undefined : basename(outcome.archivePath);
    if (outcome.ok) log(`keeper task ${taskId}: done`);
    else log(`keeper task ${taskId}: ${outcome.verdict} (${outcome.message})`);
    return {
      action: "spawned",
      taskId,
      verdict: outcome.ok ? undefined : outcome.verdict,
      archivePath: outcome.archivePath,
      abandoned,
      windowStart: windowStartIso,
    };
  } catch (error) {
    // The claim never succeeded, so nothing of ours runs: the holder keeps the slot.
    if (error instanceof LockBusyError) {
      log(`keeper window ${windowStartIso}: ${error.message}, skip`);
      return { action: "skipped", reason: "lock-busy", abandoned, windowStart: windowStartIso };
    }
    throw error;
  } finally {
    // Kills only the Instance this run started; a foreign one was never ours.
    await runner.dispose();
  }
}
