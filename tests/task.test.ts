// Ticket #18 slice 3: the blocking Task path end to end — real Lock file, real
// FreebuffDriver, real ConPTY child (the protocol stub), real clock, temp dirs
// only. The stub command is injected; the real freebuff CLI is never spawned.
// Integration tier: the subject is a real PTY child process, so deterministic
// virtual time cannot drive it and every wait is a bounded poll.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LockBusyError, pidAlive, writeLock } from "../src/lock";
import { TurnRunner } from "../src/turnRunner";
import { eventsOf, kindsOf, readInputLog } from "./helpers/stubInputLog";

const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const TIMINGS = { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 };
const PROMPT = "hello task";
const ANSWER = `stub(DeepSeek V4.1 Flash): ${PROMPT}`;

const lockPathOf = (pluginDir: string): string => join(pluginDir, "lock.json");

const harness = (
  mode: string,
  stubEnv: Record<string, string> = {},
  lockDeps: { deadlineMs?: number } = {},
  timings: Partial<typeof TIMINGS> = {},
) => {
  const pluginDir = mkdtempSync(join(tmpdir(), "task-plugin-"));
  const configDir = mkdtempSync(join(tmpdir(), "task-config-"));
  const workspace = mkdtempSync(join(tmpdir(), "task-ws-"));
  const inputLog = join(configDir, "stub-input.jsonl");
  const runner = new TurnRunner({
    pluginDir,
    workspace,
    freebuffConfigDir: configDir,
    command: { application: process.execPath, args: [stubPath] },
    env: { FREEBUFF_STUB_MODE: mode, FREEBUFF_STUB_INPUT_LOG: inputLog, ...stubEnv },
    timings: { ...TIMINGS, ...timings },
    lockDeps,
  });
  const dispose = async (): Promise<void> => {
    await runner.dispose();
    // The killed PTY child's cwd lock can outlive the kill briefly; the OS
    // cleans tmp, so a locked dir is left behind the same way sdkHarness does.
    for (const dir of [pluginDir, configDir, workspace]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // EBUSY on Windows: the child's cwd handle is still closing.
      }
    }
  };
  return { runner, pluginDir, configDir, workspace, inputLog, dispose };
};

// ~5.5KB of CJK, emoji, combining marks and newlines: under the 64KB paste
// threshold, so the runner pastes it straight.
const bigPrompt = Array.from({ length: 40 }, (_, i) => {
  const cjk = "漢字カタカナ".repeat(4);
  const emoji = "🚀🎉🀄".repeat(3);
  const marks = "café e\u0301 a\u0302 n\u0308";
  return `row ${String(i).padStart(2, "0")}: ${cjk} ${emoji} ${marks} finally plain ascii tail`;
}).join("\n");

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup !== null) await cleanup();
  cleanup = null;
});

describe("blocking Task path over the stub child", () => {
  test(
    "success: verbatim answer, lock released, instance kept for a second run without respawn",
    async () => {
      const h = harness("happy");
      cleanup = h.dispose;
      const first = await h.runner.run(PROMPT);
      expect(first).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      const second = await h.runner.run(PROMPT);
      expect(second).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "spawn")).toHaveLength(1);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "second run types /new before the second paste",
    async () => {
      const h = harness("happy");
      cleanup = h.dispose;
      expect((await h.runner.run(PROMPT)).ok).toBe(true);
      expect((await h.runner.run(PROMPT)).ok).toBe(true);

      const kinds = kindsOf(readInputLog(h.inputLog));
      expect(kinds[0]).toBe("spawn");
      const newAt = kinds.indexOf("new");
      expect(newAt).toBeGreaterThan(kinds.indexOf("submit"));
      expect(newAt).toBeLessThan(kinds.lastIndexOf("paste"));
    },
    30_000,
  );

  test(
    "multi-KB unicode prompt echoes verbatim, byte-for-byte",
    async () => {
      const h = harness("happy");
      cleanup = h.dispose;
      expect(Buffer.byteLength(bigPrompt, "utf8")).toBeGreaterThan(5_000);

      const outcome = await h.runner.run(bigPrompt);
      expect(outcome).toEqual({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${bigPrompt}`, archivePath: expect.any(String) });
      expect(Buffer.byteLength((outcome as { answer: string }).answer, "utf8")).toBe(
        Buffer.byteLength(`stub(DeepSeek V4.1 Flash): ${bigPrompt}`, "utf8"),
      );
    },
    30_000,
  );

  test(
    "ack_missing: two pastes, no bare Enter, cancel keystrokes, instance killed, lock gone",
    async () => {
      const h = harness("no-ack");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("ack_missing");

      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "paste")).toHaveLength(2);
      expect(eventsOf(events, "enter")).toHaveLength(0);
      expect(eventsOf(events, "esc")).toHaveLength(1);
      expect(eventsOf(events, "ctrl-c")).toHaveLength(3);
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "no-answer: turn ends without an answer, instance kept alive for reuse",
    async () => {
      const h = harness("no-answer");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("no_answer");
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      // no_answer keeps the Instance: the second run reuses it instead of spawning.
      const second = await h.runner.run(PROMPT);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.verdict).toBe("no_answer");
      expect(eventsOf(readInputLog(h.inputLog), "spawn")).toHaveLength(1);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "slow-ack: the working screen alone confirms the Ack while the store line is still late",
    async () => {
      const h = harness("slow-ack");
      cleanup = h.dispose;
      // The stub paints working on submit and writes the ack line ~1.5s later:
      // the screen half of the Ack carries the submit, so one paste suffices.
      const outcome = await h.runner.run(PROMPT);
      expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
      expect(eventsOf(readInputLog(h.inputLog), "paste")).toHaveLength(1);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "lost-first-submit: the re-paste retry recovers the submit in the second window",
    async () => {
      const h = harness("lost-first-submit", {}, {}, { ackMs: 900 });
      cleanup = h.dispose;
      // The stub swallows the first submit whole (no draft, no line, no screen
      // change): window 1 (0.9s) finds nothing, the single re-paste retry runs,
      // and the second submit acks inside window 2.
      const outcome = await h.runner.run(PROMPT);
      expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);
      expect(eventsOf(readInputLog(h.inputLog), "paste")).toHaveLength(2);
      expect(eventsOf(readInputLog(h.inputLog), "enter")).toHaveLength(0);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "first-submit: one bare Enter recovers the stranded draft, no extra paste",
    async () => {
      const h = harness("first-submit");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });

      expect(kindsOf(readInputLog(h.inputLog))).toEqual(["spawn", "paste", "submit", "enter"]);
      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "enter")[0].key).toBe("\r");
    },
    30_000,
  );

  test(
    "slot_held: settle fails with zero keystrokes after spawn, instance killed, lock gone",
    async () => {
      const h = harness("takeover");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.verdict).toBe("slot_held");
        expect(outcome.screenExcerpt).toEqual(expect.any(String));
      }
      expect(kindsOf(readInputLog(h.inputLog))).toEqual(["spawn"]);
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "crashed: stub exits mid-turn, crashed verdict, lock gone",
    async () => {
      const h = harness("kill-mid-turn");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("crashed");
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);
    },
    30_000,
  );

  test(
    "busy: a live foreign lock holder blocks the run and no child is spawned",
    async () => {
      const holder = Bun.spawn(["bun", "-e", "await new Promise(() => {})"]);
      try {
        const h = harness("happy", {}, { deadlineMs: 400 });
        cleanup = h.dispose;
        writeLock(h.pluginDir, {
          ownerPid: holder.pid,
          instancePid: null,
          kind: "extension",
          startedAt: new Date().toISOString(),
        });

        const failure: unknown = await h.runner.run(PROMPT).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(LockBusyError);
        expect(existsSync(h.inputLog)).toBe(false);
        expect(existsSync(join(h.pluginDir, "tasks"))).toBe(false);
      } finally {
        holder.kill();
      }
    },
    30_000,
  );

  // -- Task archive on every settle (#19 slice 2) ------------------------------

  test(
    "success settle archives the pinned file set with the verbatim prompt and answer",
    async () => {
      const h = harness("happy");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });

      const tasks = join(h.pluginDir, "tasks");
      const ids = readdirSync(tasks).sort();
      expect(ids).toHaveLength(1);
      const archive = join(tasks, ids[0]);
      // No stderr.log: ConPTY merges the child's stderr into the PTY stream,
      // so the real driver never reports a separable one.
      expect(readdirSync(archive).sort()).toEqual(["answer.md", "chat-messages.json", "meta.json", "screen.txt"]);
      const meta = JSON.parse(readFileSync(join(archive, "meta.json"), "utf8"));
      expect(meta.id).toBe(ids[0]);
      expect(meta.prompt).toBe(PROMPT);
      expect(meta.verdict).toBeNull();
      expect(meta.instancePid).toBeGreaterThan(0);
      expect(meta.phaseLog.map((entry: string) => entry.split("@")[0])).toEqual([
        "submitting",
        "working",
        "settling",
        "done",
      ]);
      expect(readFileSync(join(archive, "answer.md"), "utf8")).toBe(ANSWER);
      expect(readFileSync(join(archive, "screen.txt"), "utf8").length).toBeGreaterThan(0);
      expect(readFileSync(join(archive, "chat-messages.json"), "utf8").length).toBeGreaterThan(0);
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "failed settle archives the Verdict without an answer",
    async () => {
      const h = harness("no-ack");
      cleanup = h.dispose;
      const outcome = await h.runner.run(PROMPT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("ack_missing");

      const tasks = join(h.pluginDir, "tasks");
      const ids = readdirSync(tasks).sort();
      expect(ids).toHaveLength(1);
      const archive = join(tasks, ids[0]);
      const meta = JSON.parse(readFileSync(join(archive, "meta.json"), "utf8"));
      expect(meta.verdict).toBe("ack_missing");
      expect(meta.prompt).toBe(PROMPT);
      expect(meta.phaseLog.map((entry: string) => entry.split("@")[0])).toEqual(["submitting", "failed"]);
      expect(readFileSync(join(archive, "answer.md"), "utf8")).toBe("");
      expect(readdirSync(archive)).not.toContain("stderr.log");
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );

  test(
    "a second settle adds an archive and never rewrites the first",
    async () => {
      const h = harness("happy");
      cleanup = h.dispose;
      expect((await h.runner.run(PROMPT)).ok).toBe(true);

      const tasks = join(h.pluginDir, "tasks");
      const [first] = readdirSync(tasks).sort();
      const before = readdirSync(join(tasks, first)).map((file) => [
        file,
        readFileSync(join(tasks, first, file), "utf8"),
      ]);

      expect((await h.runner.run(PROMPT)).ok).toBe(true);

      expect(readdirSync(tasks).sort()).toHaveLength(2);
      expect(readdirSync(join(tasks, first)).map((file) => [file, readFileSync(join(tasks, first, file), "utf8")])).toEqual(
        before,
      );
      await h.runner.dispose();
      await h.runner.dispose();
    },
    30_000,
  );
});

// The cancel ladder's three outcomes (#22), over the real PTY path: graceful
// exit inside the first poll, exit after a consumed first Ctrl-C, and a wedged
// Instance only the forced kill clears. The stub's DIE_ON knob makes the two
// graceful exits reachable; without it the stub ignores every keystroke.
describe("cancel ladder over the stub child (#22)", () => {
  // ~30 s hold between the Ack and the end lines, so the turn is still working
  // when the cancel lands and only the ladder can end it.
  const HELD = "30000";

  // Bounded wall-clock polls: the counterpart is a real child behind a real
  // PTY, which fake timers cannot advance.
  const sleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };
  const until = async <T>(probe: () => T, ms: number): Promise<T | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(25);
    }
  };

  // The Ack: a chat-store line naming the prompt, so the cancel lands while
  // the Task is confirmed working.
  const acked = (configDir: string, workspace: string): boolean => {
    const chats = join(configDir, "projects", basename(workspace), "chats");
    try {
      for (const entry of readdirSync(chats)) {
        const log = join(chats, entry, "log.jsonl");
        if (existsSync(log) && readFileSync(log, "utf8").includes(JSON.stringify(PROMPT))) return true;
      }
    } catch {
      // No chats dir yet: the stub has not acked.
    }
    return false;
  };

  test(
    "outcome 1: the stub exits gracefully on Esc; one esc, zero ctrl-c, archived cancelled",
    async () => {
      const h = harness("happy", { FREEBUFF_STUB_DIE_ON: "esc", FREEBUFF_STUB_END_DELAY_MS: HELD });
      cleanup = h.dispose;
      const run = h.runner.run(PROMPT);
      expect(await until(() => acked(h.configDir, h.workspace), 10_000)).toBe(true);

      h.runner.cancel();
      const outcome = await run;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected cancelled");
      expect(outcome.verdict).toBe("cancelled");
      const archive = outcome.archivePath!;
      expect(JSON.parse(readFileSync(join(archive, "meta.json"), "utf8"))).toMatchObject({ verdict: "cancelled" });
      expect(readFileSync(join(archive, "answer.md"), "utf8")).toBe("");

      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "esc")).toHaveLength(1);
      expect(eventsOf(events, "ctrl-c")).toHaveLength(0);
      const pid = eventsOf(events, "spawn")[0]!.pid!;
      expect(await until(() => !pidAlive(pid), 5_000)).toBe(true);
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      // The next Task spawns a fresh instance.
      const second = h.runner.run(PROMPT);
      expect(await until(() => eventsOf(readInputLog(h.inputLog), "spawn").length === 2, 10_000)).toBe(true);
      await h.runner.dispose();
      await second;
    },
    30_000,
  );

  test(
    "outcome 2: the first Ctrl-C is consumed, the second exits; one esc, two ctrl-c",
    async () => {
      const h = harness("happy", { FREEBUFF_STUB_DIE_ON: "ctrl-c", FREEBUFF_STUB_END_DELAY_MS: HELD });
      cleanup = h.dispose;
      const run = h.runner.run(PROMPT);
      expect(await until(() => acked(h.configDir, h.workspace), 10_000)).toBe(true);

      h.runner.cancel();
      const outcome = await run;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected cancelled");
      expect(outcome.verdict).toBe("cancelled");
      expect(JSON.parse(readFileSync(join(outcome.archivePath!, "meta.json"), "utf8"))).toMatchObject({
        verdict: "cancelled",
      });

      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "esc")).toHaveLength(1);
      expect(eventsOf(events, "ctrl-c")).toHaveLength(2);
      const pid = eventsOf(events, "spawn")[0]!.pid!;
      expect(await until(() => !pidAlive(pid), 5_000)).toBe(true);
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      const second = h.runner.run(PROMPT);
      expect(await until(() => eventsOf(readInputLog(h.inputLog), "spawn").length === 2, 10_000)).toBe(true);
      await h.runner.dispose();
      await second;
    },
    30_000,
  );

  test(
    "outcome 3: a wedged stub ignores every keystroke; the forced kill clears it; one esc, three ctrl-c",
    async () => {
      const h = harness("wedged");
      cleanup = h.dispose;
      const run = h.runner.run(PROMPT);
      expect(await until(() => acked(h.configDir, h.workspace), 10_000)).toBe(true);

      h.runner.cancel();
      const outcome = await run;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected cancelled");
      expect(outcome.verdict).toBe("cancelled");
      expect(JSON.parse(readFileSync(join(outcome.archivePath!, "meta.json"), "utf8"))).toMatchObject({
        verdict: "cancelled",
      });

      const events = readInputLog(h.inputLog);
      expect(eventsOf(events, "esc")).toHaveLength(1);
      expect(eventsOf(events, "ctrl-c")).toHaveLength(3);
      const pid = eventsOf(events, "spawn")[0]!.pid!;
      expect(await until(() => !pidAlive(pid), 5_000)).toBe(true);
      expect(existsSync(lockPathOf(h.pluginDir))).toBe(false);

      const second = h.runner.run(PROMPT);
      expect(await until(() => eventsOf(readInputLog(h.inputLog), "spawn").length === 2, 10_000)).toBe(true);
      await h.runner.dispose();
      await second;
    },
    30_000,
  );
});
