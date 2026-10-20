// Ticket #26: the scheduled Keeper. E2E over the real stub PTY for the
// spawn/kill acceptance criteria, injected quiet dirs everywhere; the real
// freebuff CLI is never spawned.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeTaskArchive } from "../src/archive";
import { FreebuffDriver } from "../src/driver";
import { readLock, writeLock } from "../src/lock";
import { keeperPrompt, lastAllowanceReset, runKeeper, type KeeperOptions } from "../src/keeper";
import { eventsOf, readInputLog } from "./helpers/stubInputLog";

const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const TIMINGS = { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 };

let pluginDir = "";
let configDir = "";
let workspace = "";
let target = "";

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "keeper-plugin-"));
  configDir = mkdtempSync(join(tmpdir(), "keeper-config-"));
  workspace = mkdtempSync(join(tmpdir(), "keeper-ws-"));
  target = mkdtempSync(join(tmpdir(), "keeper-target-"));
});

afterEach(() => {
  for (const dir of [pluginDir, configDir, workspace, target]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows cwd lock after the PTY kill; the OS cleans tmp.
    }
  }
});

const keeperOptions = (overrides: Partial<KeeperOptions> = {}): KeeperOptions => ({
  pluginDir,
  freebuffConfigDir: configDir,
  workspace,
  target,
  log: () => {},
  ...overrides,
});

// Process death is kernel-side, so no fake clock can drive it: poll the real
// OS until the pid stops responding, like tests/lock-reclaim-real-process.test.ts.
const isDead = async (pid: number): Promise<boolean> => {
  for (let waited = 0; waited < 5_000; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  return false;
};

describe("keeper window and prompt", () => {
  test("lastAllowanceReset is the most recent 21:00 UTC instant", () => {
    expect(lastAllowanceReset(Date.UTC(2026, 6, 15, 10, 30))).toBe(Date.UTC(2026, 6, 14, 21));
    expect(lastAllowanceReset(Date.UTC(2026, 6, 15, 21))).toBe(Date.UTC(2026, 6, 15, 21));
    expect(lastAllowanceReset(Date.UTC(2026, 6, 15, 21) - 1)).toBe(Date.UTC(2026, 6, 14, 21));
  });

  test("keeperPrompt is deterministic and read-only", () => {
    expect(keeperPrompt()).toBe(keeperPrompt());
    expect(keeperPrompt()).toContain("README.md");
    expect(keeperPrompt()).toContain("Read only — do not edit anything");
  });
});

describe("runKeeper (real stub child, injected dirs)", () => {
  test(
    "AC1 quiet dirs: exactly one spawn, keeper prompt pasted, lock released, own instance dead",
    async () => {
      const inputLog = join(pluginDir, "stub-input.jsonl");
      const kindsDuringRun: (string | undefined)[] = [];
      const report = await runKeeper(keeperOptions({
        command: { application: process.execPath, args: [stubPath] },
        env: { FREEBUFF_STUB_MODE: "happy", FREEBUFF_STUB_INPUT_LOG: inputLog },
        timings: TIMINGS,
        // The claim precedes driver creation, so the record kind is readable here.
        createDriver: async () => {
          kindsDuringRun.push(readLock(pluginDir)?.kind);
          const driver = new FreebuffDriver({
            application: process.execPath,
            args: [stubPath],
            workspace,
            freebuffConfigDir: configDir,
            env: { FREEBUFF_STUB_MODE: "happy", FREEBUFF_STUB_INPUT_LOG: inputLog },
            timings: TIMINGS,
          });
          await driver.start();
          return driver;
        },
      }));

      expect(report.action).toBe("spawned");
      expect(kindsDuringRun).toEqual(["keeper"]);
      expect(report.abandoned).toEqual([]);
      expect(new Date(report.windowStart).toISOString()).toBe(report.windowStart);
      expect(report.windowStart).toBe(new Date(lastAllowanceReset(Date.now())).toISOString());

      const events = readInputLog(inputLog);
      const spawns = eventsOf(events, "spawn");
      expect(spawns).toHaveLength(1);
      expect(eventsOf(events, "paste").some((paste) => paste.text === keeperPrompt())).toBe(true);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(await isDead(spawns[0].pid!)).toBe(true);
    },
    { timeout: 60_000 },
  );

  test("AC2 archive started inside the window: skipped recent-activity, zero spawns", async () => {
    const now = Date.now();
    writeTaskArchive({
      pluginDir,
      now,
      prompt: "seed activity",
      target: null,
      model: null,
      instancePid: null,
      verdict: "no_answer",
      phaseLog: [`done@${new Date(now).toISOString()}`],
      startedAt: now - 1_000,
      answer: "",
    });
    let created = 0;
    const report = await runKeeper(keeperOptions({
      command: { application: "freebuff-never-spawned" },
      createDriver: async () => {
        created++;
        throw new Error("must not spawn");
      },
    }));

    expect(report).toMatchObject({ action: "skipped", reason: "recent-activity" });
    expect(created).toBe(0);
  });

  test("AC2 chat-store write inside the window: skipped recent-activity, zero spawns", async () => {
    const chats = join(configDir, "projects", basename(workspace), "chats", "chat-1");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "log.jsonl"), JSON.stringify({ msg: "already ran today" }) + "\n");
    let created = 0;
    const report = await runKeeper(keeperOptions({
      command: { application: "freebuff-never-spawned" },
      createDriver: async () => {
        created++;
        throw new Error("must not spawn");
      },
    }));

    expect(report).toMatchObject({ action: "skipped", reason: "recent-activity" });
    expect(created).toBe(0);
  });

  test("AC3 foreign lock held: skipped lock-busy past the deadline, nothing killed, zero spawns", async () => {
    writeLock(pluginDir, {
      ownerPid: 999_999_999,
      instancePid: null,
      kind: "extension",
      startedAt: new Date().toISOString(),
    });
    let kills = 0;
    let created = 0;
    const report = await runKeeper(keeperOptions({
      command: { application: "freebuff-never-spawned" },
      lockDeps: { isPidAlive: () => true, killPid: async () => { kills++; } },
      deadlineMs: 250,
      createDriver: async () => {
        created++;
        throw new Error("must not spawn");
      },
    }));

    expect(report).toMatchObject({ action: "skipped", reason: "lock-busy" });
    expect(kills).toBe(0);
    expect(created).toBe(0);
  });

  test("AC3 real foreign holder: the live child survives the skip", async () => {
    const child = Bun.spawn(["bun", "-e", "setInterval(() => 0, 50)"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeLock(pluginDir, {
        ownerPid: child.pid,
        instancePid: null,
        kind: "extension",
        startedAt: new Date().toISOString(),
      });
      const report = await runKeeper(keeperOptions({
        command: { application: "freebuff-never-spawned" },
        deadlineMs: 250,
      }));

      expect(report).toMatchObject({ action: "skipped", reason: "lock-busy" });
      let threw: unknown;
      try {
        process.kill(child.pid, 0);
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeUndefined();
    } finally {
      child.kill();
    }
  });

  test("AC4 live foreign instance record: skipped live-instance, zero spawns, nothing killed", async () => {
    writeFileSync(
      join(configDir, "freebuff-live-999999999.json"),
      JSON.stringify({ ownerPid: 999_999_999, model: "test-model", expiresAt: Date.now() + 60_000 }),
    );
    let kills = 0;
    let created = 0;
    const report = await runKeeper(keeperOptions({
      command: { application: "freebuff-never-spawned" },
      lockDeps: { isPidAlive: () => true, killPid: async () => { kills++; } },
      createDriver: async () => {
        created++;
        throw new Error("must not spawn");
      },
    }));

    expect(report).toMatchObject({ action: "skipped", reason: "live-instance" });
    expect(kills).toBe(0);
    expect(created).toBe(0);
  });

  test(
    "AC5 abandoned archive: reported, never resumed, the keeper spawn still happens",
    async () => {
      const old = Date.now() - 2 * 86_400_000;
      writeTaskArchive({
        pluginDir,
        now: old,
        prompt: "the abandoned prompt",
        target: "C:\\gone",
        model: null,
        instancePid: null,
        verdict: null,
        phaseLog: [`submitting@${new Date(old - 5_000).toISOString()}`, `abandoned@${new Date(old).toISOString()}`],
        startedAt: old - 6_000,
      });
      const inputLog = join(pluginDir, "stub-input.jsonl");
      const report = await runKeeper(keeperOptions({
        command: { application: process.execPath, args: [stubPath] },
        env: { FREEBUFF_STUB_MODE: "happy", FREEBUFF_STUB_INPUT_LOG: inputLog },
        timings: TIMINGS,
      }));

      expect(report.action).toBe("spawned");
      expect(report.abandoned).toHaveLength(1);
      expect(report.abandoned[0].prompt).toBe("the abandoned prompt");
      const pastes = readInputLog(inputLog).filter((entry) => entry.event === "paste");
      expect(pastes.some((paste) => paste.text === keeperPrompt())).toBe(true);
      expect(pastes.some((paste) => paste.text === "the abandoned prompt")).toBe(false);
    },
    { timeout: 60_000 },
  );
});

// AC6: the registration scripts are asserted statically; no test executes one,
// because registering a schedule mutates machine state outside the repo. Each
// platform keeps its own registration: the Linux runtime's systemd timer, the
// Windows Task Scheduler entry.
describe("registration script (static)", () => {
  test("the Linux script registers a daily 21:00 systemd timer with Persistent= and bun scripts/keeper.ts", () => {
    const text = readFileSync(join(import.meta.dir, "..", "scripts", "register-keeper-task.sh"), "utf8");
    expect(text).toContain("#!/usr/bin/env bash");
    // The Linux start-when-available equivalent: a slot missed while the machine
    // was down fires on the next boot.
    expect(text).toContain("Persistent=true");
    expect(text).toContain("OnCalendar=*-*-* 21:00:00");
    expect(text).toContain("scripts/keeper.ts");
    expect(text).toContain("--unregister");
    expect(text).toContain("--dry-run");
    expect(text).toContain("systemctl --user enable --now");
  });

  test("the Windows script registers bun scripts\\keeper.ts daily 21:00 with StartWhenAvailable and a WhatIf guard", () => {
    const text = readFileSync(join(import.meta.dir, "..", "scripts", "register-keeper-task.ps1"), "utf8");
    expect(text).toContain("-Execute 'bun.exe'");
    expect(text).toContain("-Argument 'scripts\\keeper.ts'");
    expect(text).toContain("-Daily -At '21:00'");
    expect(text).toContain("-StartWhenAvailable");
    expect(text).toContain("[CmdletBinding(SupportsShouldProcess)]");
    expect(text).toContain("-WhatIf:$WhatIfPreference");
    expect(text).toContain("Unregister-ScheduledTask");
    expect(text).toContain("$repoRoot = Split-Path $PSScriptRoot -Parent");
  });
});
