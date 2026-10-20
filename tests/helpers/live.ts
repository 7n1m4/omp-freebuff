// Shared rig for the gated live tier (PI_FREEBUFF_LIVE / PI_FREEBUFF_CAPTURE):
// temp plugin dir, Workspace and git Target, the REAL freebuff config dir and
// the bare `freebuff` command, driven through the process-scoped singleton.
// Only gated test modules may import this: a rig run consumes a real
// Hour-session task. No PTY imports here — src/host/pty.ts is the host seam.
import { execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { pidAlive, readLock, writeLock, type LockRecord } from "../../src/lock";
import { metadataVersion } from "../../src/protocol/screenDump";
import { measuredVersionReport } from "../../src/protocol/recorded";
import type { FreebuffSingleton, OwnerBinding, SettlePush } from "../../src/singleton";
import { getFreebuffSingleton, resetFreebuffForTests } from "../../src/singleton";
import { defaultFreebuffConfigDir } from "../../src/status";
import type { TurnRunnerOptions } from "../../src/turnRunner";

export const LIVE_TEST_FLAG = "PI_FREEBUFF_LIVE";
export const CAPTURE_TEST_FLAG = "PI_FREEBUFF_CAPTURE";

export const liveEnabled = (flag: string): boolean => process.env[flag] === "1";

export const sleepMs = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// Refuses (throws the report's message) when the installed CLI is not the
// measured one, so a drifted live run never reaches a spawn.
export function assertMeasuredVersion(): string {
  const installed = metadataVersion(defaultFreebuffConfigDir());
  const report = measuredVersionReport(installed);
  if (installed === null || !report.ok) throw new Error(report.message);
  return installed;
}

export interface LiveRig {
  pluginDir: string;
  workspace: string;
  target: string;
  configDir: string;
  singleton: FreebuffSingleton;
}

// The real config dir is deliberate: login state and freebuff-metadata.json
// live there and a temp copy would change what the child sees. Everything else
// is disposable temp; the production plugin dir is never touched.
export function buildLiveRig(opts: { lockDeadlineMs?: number } = {}): LiveRig {
  const pluginDir = mkdtempSync(join(tmpdir(), "live-plugin-"));
  const workspace = mkdtempSync(join(tmpdir(), "live-ws-"));
  const target = mkdtempSync(join(tmpdir(), "live-target-"));
  execFileSync("git", ["init"], { cwd: target, stdio: "ignore" });
  resetFreebuffForTests();
  const configDir = defaultFreebuffConfigDir();
  const options: TurnRunnerOptions = {
    pluginDir,
    workspace,
    freebuffConfigDir: configDir,
    command: { application: "freebuff" },
    ...(opts.lockDeadlineMs === undefined ? {} : { lockDeps: { deadlineMs: opts.lockDeadlineMs } }),
  };
  return { pluginDir, workspace, target, configDir, singleton: getFreebuffSingleton(() => ({ runner: options })) };
}

// A test-side owner binding: the settle push lands in `pushes` for the
// push-vs-poll comparison, paint is dropped.
export function liveBinding(pushes: SettlePush[]): OwnerBinding {
  return {
    sessionId: "live-tier",
    label: "live tier",
    hasUI: false,
    paint: () => {},
    push: (payload) => pushes.push(payload),
  };
}

// Plants a live foreign keeper Lock: a bun sleeper owns the record, so the
// next claim must wait out its deadline and refuse, never reclaim. Waits for
// the sleeper's liveness first — a dead owner would read as stale.
export async function plantKeeperLock(pluginDir: string): Promise<{ pid: number; record: LockRecord; kill: () => void }> {
  const child = Bun.spawn(["bun", "-e", "setInterval(() => 0, 50)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const pid = child.pid;
    for (let waited = 0; !pidAlive(pid) && waited < 5_000; waited += 50) await sleepMs(50);
    if (!pidAlive(pid)) throw new Error(`sleeper pid ${pid} never came up`);
    const record: LockRecord = {
      ownerPid: pid,
      instancePid: null,
      kind: "keeper",
      startedAt: new Date().toISOString(),
    };
    writeLock(pluginDir, record);
    return { pid, record, kill: () => child.kill() };
  } catch (error) {
    child.kill();
    throw error;
  }
}

// A terminated pid can take a moment before `process.kill(pid, 0)` reports it
// gone — Windows keeps the pid alive until the last handle closes, and the PTY
// host holds one briefly; on Linux the reap window is shorter but still real.
// killPid's caller waits out the same window. Returns the final liveness.
async function awaitPidDead(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (pidAlive(pid) && Date.now() < deadline) await sleepMs(100);
  return !pidAlive(pid);
}

// Teardown plus the no-orphan asserts (ticket #27 AC 6): the Lock record is
// gone and the recorded Instance pid is dead. Both inputs are logged so the
// console carries the evidence. Windows-tolerant rm: the killed child's cwd
// or the junction can hold a dir briefly; the OS cleans tmp.
export async function teardownLiveRig(rig: LiveRig, instancePid: number | null): Promise<void> {
  try {
    try {
      await rig.singleton.teardown();
    } finally {
      resetFreebuffForTests();
    }
    const lock = readLock(rig.pluginDir);
    console.log(`[live] teardown: readLock(${rig.pluginDir}) -> ${lock === null ? "null" : JSON.stringify(lock)}`);
    expect(lock).toBeNull();
    if (instancePid === null) return;
    const waitedDead = await awaitPidDead(instancePid);
    console.log(`[live] teardown: instance pid ${instancePid} dead (after reap wait) -> ${waitedDead}`);
    expect(waitedDead).toBe(true);
  } finally {
    for (const dir of [rig.workspace, rig.pluginDir, rig.target]) {
      try {
        unlinkSync(join(dir, "repo")); // the junction: rmSync faults on it under Bun
      } catch {
        // No junction, or the refusal path never made one in workspace.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Held briefly by the killed child's cwd; the OS cleans tmp.
      }
    }
  }
}
