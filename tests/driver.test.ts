import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FreebuffDriver, FreebuffDriverError, resolveWindowsCommand } from "../src/driver";
import { readChats } from "../src/protocol/chatStore";
import { eventsOf, readInputLog } from "./helpers/stubInputLog";

// The stub child stands in for freebuff in every test here; the driver always
// gets the stub command injected (process.execPath + stub path), never the real
// CLI. Config dir and workspace are per-test temp dirs.
const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const PROMPT = "hello driver";
const ANSWER = `stub(DeepSeek V4.1 Flash): ${PROMPT}`;
const MODEL_METADATA = { version: "9.9.9-test" };

const harness = (mode: string, stubEnv: Record<string, string> = {}) => {
  const configDir = mkdtempSync(join(tmpdir(), "freebuff-config-"));
  const workspace = mkdtempSync(join(tmpdir(), "freebuff-ws-"));
  const inputLog = join(configDir, "stub-input.jsonl");
  const driver = new FreebuffDriver({
    application: process.execPath,
    args: [stubPath],
    workspace,
    freebuffConfigDir: configDir,
    env: { FREEBUFF_STUB_MODE: mode, FREEBUFF_STUB_INPUT_LOG: inputLog, ...stubEnv },
    timings: { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 },
  });
  return { driver, workspace, configDir, inputLog };
};

// Real clocks only: the subject is a real ConPTY child process; fake timers
// cannot drive it, so every wait here is a bounded poll on an awaited
// condition, never a fixed "long enough" sleep.
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// Polls the probe until it returns a value or the budget runs out (null).
const until = async <T>(probe: () => T | Promise<T>, ms: number): Promise<T | null> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
};

describe("FreebuffDriver over the stub child", () => {
  test(
    "happy path: settle idle, paste, ack, working screen, turn end answer verbatim",
    async () => {
      const { driver, inputLog } = harness("happy");
      await driver.start();
      expect(await driver.waitSettled()).toEqual({ ok: true, state: "idle" });
      expect(driver.alive()).toBe(true);
      expect(driver.pid()).toEqual(expect.any(Number));

      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);

      // The Ack: a chat-store line naming the prompt.
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();
      // Signal the submit crossed into the working state, through the real
      // recognition table.
      expect(await until(async () => (await driver.classify()).identity === "working", 3_000)).toBe(true);
      const end = await until(() => {
        const result = driver.turnEndSince(baseline);
        return result.done ? result : null;
      }, 5_000);
      expect(end?.answer).toBe(ANSWER);
      // The store is the turn-end truth; the stub repaints ready a beat after
      // the end line, so the screen is awaited, never assumed.
      expect(await until(async () => (await driver.classify()).identity === "ready", 3_000)).toBe(true);

      // Input-log whitelist: exactly one paste and its submit Enter.
      const events = readInputLog(inputLog);
      expect(events.map((entry) => entry.event)).toEqual(["spawn", "paste", "submit"]);
      expect(events[1].text).toBe(PROMPT);
      expect(events[2].text).toBe(PROMPT);
      await driver.kill();
    },
    20_000,
  );

  test(
    "no-ack: ackSince stays false across the budget, no bare Enter, no re-paste",
    async () => {
      const { driver, inputLog } = harness("no-ack");
      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);

      // Single-window primitives only: the driver polls, never re-pastes; the
      // two-window policy lives in the turn runner above it.
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        expect(driver.ackSince(baseline, PROMPT)).toBe(false);
        await sleep(50);
      }

      const events = readInputLog(inputLog);
      expect(eventsOf(events, "paste")).toHaveLength(1);
      expect(eventsOf(events, "submit")).toHaveLength(1);
      expect(eventsOf(events, "enter")).toHaveLength(0);
      await driver.kill();
    },
    20_000,
  );

  test(
    "first-submit: draft screen, exactly one bare Enter recovers the submit",
    async () => {
      const { driver, inputLog } = harness("first-submit");
      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);

      // The submit stranded as a draft: the pasted text sits in the composer.
      expect(await until(async () => (await driver.classify()).identity === "draft", 3_000)).toBe(true);

      // The recovery is one bare Enter, never a re-paste.
      driver.press("\r");
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();
      const end = await until(() => {
        const result = driver.turnEndSince(baseline);
        return result.done ? result : null;
      }, 5_000);
      expect(end?.answer).toBe(ANSWER);

      const events = readInputLog(inputLog);
      expect(eventsOf(events, "paste")).toHaveLength(1);
      expect(eventsOf(events, "enter")).toHaveLength(1);
      expect(eventsOf(events, "enter")[0].key).toBe("\r");
      await driver.kill();
    },
    20_000,
  );

  test(
    "cost-modal: the settle loop confirms with one throttled Enter, turn completes",
    async () => {
      const { driver, inputLog } = harness("cost-modal");
      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);

      // The modal pops over the welcome box; once it is up, the settle loop's
      // single keystroke confirms it (throttle mechanics are settle.ts's).
      expect(await until(async () => (await driver.classify()).identity === "cost modal", 3_000)).toBe(true);
      expect(await driver.waitSettled()).toEqual({ ok: true, state: "ready" });
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();
      const end = await until(() => {
        const result = driver.turnEndSince(baseline);
        return result.done ? result : null;
      }, 5_000);
      expect(end?.answer).toBe(ANSWER);

      const events = readInputLog(inputLog);
      expect(eventsOf(events, "paste")).toHaveLength(1);
      // The paste's closing Enter submitted into the modal, and the confirm
      // Enter resubmitted the held draft — no bare Enter either way.
      expect(eventsOf(events, "submit").map((entry) => entry.text)).toEqual([PROMPT, PROMPT]);
      expect(eventsOf(events, "enter")).toHaveLength(0);
      await driver.kill();
    },
    20_000,
  );

  test(
    "takeover: settle fails slot_held with zero keystrokes after spawn",
    async () => {
      const { driver, inputLog } = harness("takeover");
      await driver.start();
      const outcome = await driver.waitSettled();
      expect(outcome).toMatchObject({ ok: false, reason: "slot_held" });
      expect(readInputLog(inputLog).map((entry) => entry.event)).toEqual(["spawn"]);
      await driver.kill();
    },
    20_000,
  );

  test(
    "displaced: settle fails displaced with zero keystrokes after spawn",
    async () => {
      const { driver, inputLog } = harness("displaced");
      await driver.start();
      const outcome = await driver.waitSettled();
      expect(outcome).toMatchObject({ ok: false, reason: "displaced" });
      expect(readInputLog(inputLog).map((entry) => entry.event)).toEqual(["spawn"]);
      await driver.kill();
    },
    20_000,
  );

  test(
    "unknown: ready_timeout after budget, one unrecognized dump per freeze key",
    async () => {
      const { driver, configDir, inputLog } = harness("unknown");
      writeFileSync(join(configDir, "freebuff-metadata.json"), JSON.stringify(MODEL_METADATA));
      await driver.start();
      const outcome = await driver.waitSettled({ readyMs: 900 });
      expect(outcome).toMatchObject({ ok: false, reason: "ready_timeout" });
      const dumps = readdirSync(join(configDir, "screen-dumps", MODEL_METADATA.version));
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/^unrecognized-[0-9a-f]{64}\.ansi$/);
      expect(readInputLog(inputLog).map((entry) => entry.event)).toEqual(["spawn"]);
      await driver.kill();
    },
    20_000,
  );

  test(
    "kill-mid-turn: exit recorded, turnEndSince keeps saying not done, press wraps process_exited",
    async () => {
      const { driver } = harness("kill-mid-turn");
      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();

      // The stub exits before the turn end: the caller decides crashed.
      expect(await until(() => !driver.alive(), 3_000)).toBe(true);
      expect(driver.exitCode()).toBe(1);
      expect(driver.pid()).toBeNull();
      expect(driver.turnEndSince(baseline)).toEqual({ done: false, answer: null });

      let error: unknown = null;
      try {
        driver.press("\r");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(FreebuffDriverError);
      expect((error as FreebuffDriverError).reason).toBe("process_exited");
    },
    20_000,
  );

  test(
    "cancelActive: Esc then three Ctrl-C, then the forced kill",
    async () => {
      const { driver, inputLog } = harness("happy");
      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      await driver.pastePrompt(PROMPT);
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();

      await driver.cancelActive();
      expect(driver.alive()).toBe(false);

      const events = readInputLog(inputLog);
      expect(eventsOf(events, "esc")).toHaveLength(1);
      expect(eventsOf(events, "esc")[0].key).toBe("\x1b");
      expect(eventsOf(events, "ctrl-c")).toHaveLength(3);
      for (const entry of eventsOf(events, "ctrl-c")) expect(entry.key).toBe("\x03");
    },
    20_000,
  );

  test(
    "baseline and ackSince read the store across rotated chat dirs",
    async () => {
      const { driver, workspace, configDir } = harness("happy");
      // A pre-existing chat dir older than the baseline: ack must not read it.
      const pre = join(configDir, "projects", basename(workspace), "chats", "chat-0");
      mkdirSync(pre, { recursive: true });
      writeFileSync(join(pre, "log.jsonl"), JSON.stringify({ msg: PROMPT }) + "\n");

      await driver.start();
      await driver.waitSettled();
      const baseline = driver.baseline();
      expect(baseline).toEqual({ dirName: "chat-0", logBytes: readFileSync(join(pre, "log.jsonl")).length });
      expect(driver.ackSince(baseline, PROMPT)).toBe(false);

      await driver.pastePrompt(PROMPT);
      expect(await until(() => driver.ackSince(baseline, PROMPT), 3_000)).not.toBeNull();
      // The Turn landed in a NEWER chat dir; the snapshots prove it.
      const snaps = readChats(configDir, workspace);
      expect(snaps.map((snap) => snap.dirName)).toContain("chat-1");
      await driver.kill();
    },
    20_000,
  );
});

describe("driver spawn seam (Windows)", () => {
  test("start rejects when the application is not a Win32 executable", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "freebuff-config-"));
    const workspace = mkdtempSync(join(tmpdir(), "freebuff-ws-"));
    const notExecutable = join(configDir, "cli.txt");
    writeFileSync(notExecutable, "not an executable");
    const driver = new FreebuffDriver({ application: notExecutable, workspace, freebuffConfigDir: configDir });
    // CreateProcessW fails with os error 193; the rejection must reach start(),
    // never wedge it (the live tier hung exactly here, Lock claimed, no verdict).
    await expect(driver.start()).rejects.toThrow(/os error 193/);
  });

  test("resolveWindowsCommand resolves a bare npm shim to its .cmd as the application", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "shim-dir-"));
    writeFileSync(join(shimDir, "mycli"), "#!/bin/sh\necho sh shim\n");
    writeFileSync(join(shimDir, "mycli.cmd"), "@echo off\r\necho hi\r\n");
    const resolved = resolveWindowsCommand("mycli", {
      PATH: shimDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    expect(resolved).toEqual({ application: join(shimDir, "mycli.cmd"), args: [] });
  });

  test("resolveWindowsCommand resolves a bare .exe directly", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "shim-dir-"));
    writeFileSync(join(shimDir, "tool.exe"), "MZ");
    const resolved = resolveWindowsCommand("tool", {
      PATH: shimDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    expect(resolved).toEqual({ application: join(shimDir, "tool.exe"), args: [] });
  });

  test("resolveWindowsCommand passes paths through and leaves misses for CreateProcess to reject", () => {
    expect(resolveWindowsCommand("C:\\some\\dir\\cli.exe", { PATH: "", PATHEXT: "" })).toEqual({
      application: "C:\\some\\dir\\cli.exe",
      args: [],
    });
    expect(resolveWindowsCommand("no-such-cli", { PATH: "", PATHEXT: "" })).toEqual({
      application: "no-such-cli",
      args: [],
    });
  });

  test(
    "a .cmd under a spaced directory spawns and runs (regression: ComSpec /s /c split spaced paths)",
    async () => {
      const spacedDir = mkdtempSync(join(tmpdir(), "shim dir with spaces-"));
      const workspace = mkdtempSync(join(tmpdir(), "freebuff-ws-"));
      const configDir = mkdtempSync(join(tmpdir(), "freebuff-config-"));
      writeFileSync(join(spacedDir, "mycli.cmd"), "@echo off\r\necho SPACED-SHIM-OK\r\n");
      const driver = new FreebuffDriver({
        application: join(spacedDir, "mycli.cmd"),
        workspace,
        freebuffConfigDir: configDir,
        timings: { settleMs: 2_000, ackMs: 1_000, pollMs: 25, pasteSettleMs: 50, pressThrottleMs: 100 },
      });
      try {
        await driver.start();
        await until(() => (driver.alive() ? null : true), 5_000);
        expect(await driver.screenText()).toContain("SPACED-SHIM-OK");
      } finally {
        try {
          await driver.kill();
        } catch {
          // already exited
        }
      }
    },
    20_000,
  );
});
