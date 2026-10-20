// The port's platform seam: the one module the tree branches the OS through.
// Linux is the runtime, so every property here is the Linux behaviour, exercised
// against real processes and real executables — no stubs, no node_modules, no
// network, and never the machine-wide plugin directory.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isWindows, killPid, pluginDir, resolveApplication } from "../src/platform";
import { pidAlive } from "../src/lock";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "platform-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Real-time polls, deliberately not fake timers: the awaited conditions are OS
// process liveness and a child PTY rendering, neither of which an in-test clock
// can drive.
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const waitAlive = async (pid: number): Promise<void> => {
  for (let waited = 0; !pidAlive(pid) && waited < 5_000; waited += 50) await sleep(50);
};

const waitDead = async (pid: number): Promise<void> => {
  for (let waited = 0; pidAlive(pid) && waited < 5_000; waited += 50) await sleep(50);
};

// A throwaway child that would idle forever if nobody killed it.
const spawnSleeper = (): number =>
  Bun.spawn(["bun", "-e", "setInterval(() => 0, 50)"], { stdout: "ignore", stderr: "ignore" }).pid;

describe("pluginDir", () => {
  test("is freebuff-plugin under XDG_STATE_HOME, never LOCALAPPDATA (AC #7)", () => {
    // The POSIX branch is the runtime; on Windows this file is a no-op and the
    // Windows branch is what runs, so asserting it there would be dishonest.
    if (isWindows) return;
    const stateHome = join(root, "state-home");
    const prior = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = stateHome;
      expect(pluginDir()).toBe(join(stateHome, "freebuff-plugin"));
    } finally {
      if (prior === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prior;
    }
  });

  test("falls back to ~/.local/state when XDG_STATE_HOME is unset (AC #7)", () => {
    if (isWindows) return;
    const prior = process.env.XDG_STATE_HOME;
    try {
      delete process.env.XDG_STATE_HOME;
      // Only the shape is asserted: the real home is machine state a test must
      // never depend on, and never mutated.
      expect(pluginDir()).toMatch(/[\\/]\.local[\\/]state[\\/]freebuff-plugin$/);
      expect(pluginDir()).not.toContain("AppData");
    } finally {
      if (prior !== undefined) process.env.XDG_STATE_HOME = prior;
    }
  });
});

describe("resolveApplication", () => {
  test("resolves a bare name over PATH to the executable hit", () => {
    const shimDir = join(root, "shims");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "mycli"), "#!/bin/sh\necho hi\n");
    expect(resolveApplication("mycli", { PATH: shimDir, PATHEXT: "" })).toEqual({
      application: join(shimDir, "mycli"),
      args: [],
    });
  });

  test("passes an explicit path through unchanged, spaces included", () => {
    const spaced = join(root, "spaced dir", "mycli");
    expect(resolveApplication(spaced, { PATH: "", PATHEXT: "" })).toEqual({ application: spaced, args: [] });
  });

  test("leaves a PATH miss for the spawner to reject", () => {
    // The property the old CreateProcessW tests protected: the application
    // handed to the PTY host never resolves to an unexecutable shim, and a
    // bogus one is NOT silently replaced — the spawn then fails loudly.
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(resolveApplication("no-such-cli", { PATH: empty, PATHEXT: "" })).toEqual({
      application: "no-such-cli",
      args: [],
    });
  });

  test("resolves a real executable on this box to a real file", () => {
    // A real PATH hit — sh, present on every Linux workstation — so the hit the
    // driver hands the PTY host is genuinely executable.
    const resolved = resolveApplication("sh", { PATH: process.env.PATH ?? "", PATHEXT: "" });
    expect(statSync(resolved.application).isFile()).toBe(true);
  });
});

describe("killPid", () => {
  test("SIGTERM reaches a live child and the pid is gone afterwards (AC #1)", async () => {
    const pid = spawnSleeper();
    try {
      await waitAlive(pid);
      expect(pidAlive(pid)).toBe(true);
      await killPid(pid);
      await waitDead(pid);
      expect(pidAlive(pid)).toBe(false);
    } finally {
      // A failed assertion must never leak the child.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });

  test("an already-dead pid is a tolerated no-op, never a throw (AC #1)", async () => {
    await expect(killPid(999_999_999)).resolves.toBeUndefined();
  });
});
