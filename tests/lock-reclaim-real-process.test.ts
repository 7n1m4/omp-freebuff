// Ticket #17 slice 2b: reclaim against a REAL child process (AC #5). Proves the
// recorded Instance dies and leaves no process behind: spawn bun, wait alive,
// seed the Lock with its pid, reclaim with real pidAlive + killInstance.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { killInstance, pidAlive, readLock, reclaimLock, writeLock } from "../src/lock";

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "lock-reclaim-test-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

test("reclaim kills the recorded instance and deletes the record (AC #5)", async () => {
  // A throwaway child that would idle forever if nobody killed it.
  const child = Bun.spawn(["bun", "-e", "setInterval(() => 0, 50)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const pid = child.pid;
    // Real-time poll, deliberately not fake timers: the awaited condition is an
    // OS process reaching liveness, which no in-test clock can drive.
    for (let waited = 0; !pidAlive(pid) && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pidAlive(pid)).toBe(true);

    // A stale record (dead owner, ancient startedAt) whose instancePid is the
    // live child: the next claimer must kill the child, not adopt it.
    writeLock(pluginDir, {
      ownerPid: 999_999_999,
      instancePid: pid,
      kind: "extension",
      startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });

    await reclaimLock(pluginDir); // real pidAlive + killInstance (SIGTERM/SIGKILL)

    let threw: unknown;
    try {
      process.kill(pid, 0);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeDefined();
    expect(readLock(pluginDir)).toBeNull();
  } finally {
    // A failed assertion must never leak the child.
    child.kill();
  }
});

test("killInstance on an already-dead pid is an idempotent no-op (AC #5)", async () => {
  await expect(killInstance(999_999_999)).resolves.toBeUndefined();
});
