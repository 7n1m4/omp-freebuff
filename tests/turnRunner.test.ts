// Ticket #18 slice 3: the turn runner's policy tier. A ScriptedDriver on a
// VirtualClock drives every branch of the submit pipeline (CONTEXT: TurnRunner);
// the Lock file is the real one, everything else is in-memory and virtual-time.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LockBusyError, writeLock } from "../src/lock";
import { FreebuffDriverError } from "../src/driver";
import { COUNTDOWN_REGEX, END_SESSION } from "../src/protocol/markers";
import { classifyScreen } from "../src/protocol/screen";
import { TurnRunner, type TurnPhase, type TurnRunnerOptions } from "../src/turnRunner";
import { replayFixture } from "./helpers/replay";
import { ScriptedDriver, type ScriptedEvent } from "./helpers/scriptedDriver";
import { VirtualClock } from "./helpers/virtualClock";

const TIMINGS = { settleMs: 200, ackMs: 200, pollMs: 25, pasteSettleMs: 5, pressThrottleMs: 50 };
const PROMPT = "hello runner";
const ANSWER = "line1\nline2 🚀 verbatim";

const DRAFT_FRAME = await replayFixture("0.2.29/queued-composer");
const WORKING_FRAME = await replayFixture("0.2.29/working");
const MODAL_FRAME = await replayFixture("0.2.12/cost-modal");
// The displaced-looking draft: the same frame with the usage row gone, so the
// bare-Enter discriminator (END_SESSION or a countdown) finds nothing.
const DRAFT_NO_USAGE = DRAFT_FRAME.split("\n")
  .filter((line) => !(line.includes(END_SESSION) || COUNTDOWN_REGEX.test(line)))
  .join("\n");

let pluginDir = "";
let clock: VirtualClock;
let scripted: ScriptedDriver;
let created = 0;

const clockSleep = (virtual: VirtualClock) => (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  virtual.setTimeout(resolve, ms);
  return promise;
};

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "turn-runner-"));
  clock = new VirtualClock();
  scripted = new ScriptedDriver(clockSleep(clock));
  created = 0;
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

const lockPath = () => join(pluginDir, "lock.json");

const newRunner = (
  lockDeps?: { isPidAlive?: (pid: number) => boolean; deadlineMs?: number },
  driver: ScriptedDriver = scripted,
  extra?: Pick<TurnRunnerOptions, "taskId" | "onPhase" | "watchdog">,
): TurnRunner =>
  new TurnRunner({
    pluginDir,
    workspace: join(pluginDir, "ws"),
    freebuffConfigDir: join(pluginDir, "cfg"),
    command: { application: "freebuff-never-spawned" },
    timings: TIMINGS,
    clock,
    createDriver: async () => {
      created++;
      driver.started();
      return driver;
    },
    lockDeps,
    ...extra,
  });

// Runs `promise` to completion on the virtual clock: timers only fire inside
// advance, and each advance flushes the awaited continuations before the next.
// The rejection handler must attach to `settled.promise` at creation: a run can
// reject mid-advance, and an unhandled gap makes bun fail the test on the spot.
const drive = async <T>(promise: Promise<T>, budgetMs = 60_000): Promise<T> => {
  const settled = Promise.withResolvers<T>();
  const guarded: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> = settled.promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let done = false;
  void promise.then(
    (value) => {
      done = true;
      settled.resolve(value);
    },
    (error) => {
      done = true;
      settled.reject(error);
    },
  );
  const end = clock.now() + budgetMs;
  while (!done && clock.now() < end) await clock.advance(25);
  if (!done) throw new Error("virtual time budget exhausted before the run settled");
  const result = await guarded;
  if (!result.ok) throw result.error;
  return result.value;
};

const pastesOf = (): unknown[] => scripted.events.filter((entry) => entry.event === "paste");
type EnterEvent = Extract<ScriptedEvent, { event: "enter" }>;
const isEnter = (entry: ScriptedEvent): entry is EnterEvent => entry.event === "enter";
const entersOf = (): EnterEvent[] => scripted.events.filter(isEnter);
const kindsOf = (): string[] => scripted.events.map((entry) => entry.event);
const ackAndEnd = (): void => {
  scripted.ack(PROMPT);
  scripted.endTurn(ANSWER);
};

describe("TurnRunner policy (scripted driver, virtual clock, real lock file)", () => {
  test("fresh instance submits without /new; a reused instance types /new before the paste", async () => {
    const runner = newRunner();
    scripted.afterPaste = ackAndEnd;

    const first = await drive(runner.run(PROMPT));
    expect(first).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(kindsOf()).toEqual(["spawn", "paste", "submit"]);

    scripted.settle = { ok: true, state: "ready" };
    scripted.events = [];
    const second = await drive(runner.run(PROMPT));
    expect(second).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    // No spawn: the live instance is reused, so the run opens with /new.
    expect(kindsOf()).toEqual(["new", "paste", "submit"]);
    // One factory call across both runs: the live instance was reused.
    expect(created).toBe(1);
    expect(scripted.isAlive).toBe(true);
  });

  test("success releases the lock and returns the answer verbatim", async () => {
    const runner = newRunner();
    scripted.afterPaste = () => {
      scripted.ack(PROMPT);
      scripted.endTurn(ANSWER);
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(existsSync(lockPath())).toBe(false);
    expect(scripted.isAlive).toBe(true);
  });

  test("no ack signals: exactly two pastes, then ack_missing, instance killed, lock gone", async () => {
    const runner = newRunner();
    const outcome = await drive(runner.run(PROMPT));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.verdict).toBe("ack_missing");
      expect(outcome.screenExcerpt).toEqual(expect.any(String));
    }
    expect(pastesOf()).toHaveLength(2);
    expect(entersOf()).toHaveLength(0);
    // Nothing typed into the unnamed frames either.
    expect(kindsOf()).toEqual(["spawn", "paste", "submit", "paste", "submit"]);
    expect(scripted.calls.cancelActive).toBe(1);
    expect(scripted.isAlive).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("ack via store line in window 1: single paste, no keystrokes", async () => {
    const runner = newRunner();
    scripted.afterPaste = ackAndEnd;

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(pastesOf()).toHaveLength(1);
    expect(entersOf()).toHaveLength(0);
  });

  test("ack via working screen alone: single paste, no keystrokes", async () => {
    const runner = newRunner();
    scripted.afterPaste = () => {
      scripted.screen = WORKING_FRAME;
      clock.setTimeout(() => scripted.endTurn(ANSWER), 3 * TIMINGS.pollMs);
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(pastesOf()).toHaveLength(1);
    expect(entersOf()).toHaveLength(0);
  });

  test("draft with usage row: exactly one bare Enter, never a re-paste, submit recovers", async () => {
    const runner = newRunner();
    expect(classifyScreen(DRAFT_FRAME).identity).toBe("draft");
    scripted.afterPaste = () => {
      scripted.screen = DRAFT_FRAME;
    };
    scripted.onEnter = () => {
      scripted.screen = WORKING_FRAME;
      ackAndEnd();
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(pastesOf()).toHaveLength(1);
    expect(entersOf().map((entry) => entry.key)).toEqual(["\r"]);
  });

  test("draft without usage row never earns the bare Enter: two pastes, ack_missing", async () => {
    const runner = newRunner();
    expect(classifyScreen(DRAFT_NO_USAGE).identity).toBe("draft");
    scripted.afterPaste = () => {
      scripted.screen = DRAFT_NO_USAGE;
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.verdict).toBe("ack_missing");
    expect(pastesOf()).toHaveLength(2);
    expect(entersOf()).toHaveLength(0);
    expect(scripted.isAlive).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("cost modal during the ack window: one confirm Enter, submit completes", async () => {
    const runner = newRunner();
    expect(classifyScreen(MODAL_FRAME).identity).toBe("cost modal");
    scripted.afterPaste = () => {
      scripted.screen = MODAL_FRAME;
    };
    scripted.onEnter = () => {
      scripted.screen = WORKING_FRAME;
      ackAndEnd();
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(pastesOf()).toHaveLength(1);
    expect(entersOf().map((entry) => entry.key)).toEqual(["\r"]);
  });

  test("driver dies mid-turn: crashed verdict, instance dropped, lock released", async () => {
    const runner = newRunner();
    scripted.afterPaste = () => {
      scripted.ack(PROMPT);
      scripted.isAlive = false;
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.verdict).toBe("crashed");
    expect(existsSync(lockPath())).toBe(false);
    expect(scripted.calls.kill).toBe(1);
  });

  test("turn ends without an answer: no_answer verdict, instance kept for reuse", async () => {
    const runner = newRunner();
    scripted.afterPaste = () => {
      scripted.ack(PROMPT);
      scripted.endTurn(null);
    };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.verdict).toBe("no_answer");
    expect(scripted.isAlive).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  test.each([
    ["slot_held", "slot_held"],
    ["displaced", "displaced"],
    ["needs_login", "driver_error"],
    ["ready_timeout", "driver_error"],
  ] as const)("settle %s maps to verdict %s with the instance killed and zero keystrokes", async (reason, verdict) => {
    const runner = newRunner();
    scripted.settle = { ok: false, reason, excerpt: "held frame" };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.verdict).toBe(verdict);
      expect(outcome.screenExcerpt).toBe("held frame");
    }
    expect(kindsOf()).toEqual(["spawn"]);
    expect(scripted.isAlive).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("lock held by a live foreign owner: LockBusyError propagates and nothing spawns", async () => {
    writeLock(pluginDir, {
      ownerPid: 999_999_999,
      instancePid: null,
      kind: "keeper",
      startedAt: new Date(clock.now()).toISOString(),
    });
    const runner = newRunner({ isPidAlive: () => true, deadlineMs: 100 });

    const failure: unknown = await drive(runner.run(PROMPT)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LockBusyError);
    expect(created).toBe(0);
    expect(kindsOf()).toEqual([]);
    expect(existsSync(lockPath())).toBe(true);
    expect(existsSync(join(pluginDir, "tasks"))).toBe(false);
  });

  // -- Task archive on every settle (#19 slice 2) ------------------------------

  const archiveIds = (): string[] => {
    const tasksPath = join(pluginDir, "tasks");
    return existsSync(tasksPath) ? readdirSync(tasksPath).sort() : [];
  };
  const readArchive = (id: string): Record<string, string> => {
    const dir = join(pluginDir, "tasks", id);
    return Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]));
  };
  type ArchiveMeta = {
    id: string;
    prompt: string;
    target: string | null;
    model: string | null;
    instancePid: number | null;
    verdict: string | null;
    phaseLog: string[];
    timings: { startedAt: number; settledAt: number; elapsedMs: number };
  };
  const phaseNames = (meta: ArchiveMeta): string[] => meta.phaseLog.map((entry) => entry.split("@")[0]);
  const expectMonotone = (meta: ArchiveMeta): void => {
    const stamps = meta.phaseLog.map((entry) => Date.parse(entry.split("@")[1]));
    for (const stamp of stamps) expect(stamp).not.toBeNaN();
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
  };

  test("success settle writes one Task archive with the pinned file set and meta", async () => {
    mkdirSync(join(pluginDir, "cfg"), { recursive: true });
    writeFileSync(
      join(pluginDir, "cfg", "freebuff-live-4242.json"),
      JSON.stringify({ ownerPid: 4242, model: "stub-model", expiresAt: 1 }),
    );
    scripted.screen = "settle frame\r\n";
    scripted.afterPaste = ackAndEnd;
    const startedAt = clock.now();

    const outcome = await drive(newRunner().run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });

    const ids = archiveIds();
    expect(ids).toHaveLength(1);
    const files = readArchive(ids[0]);
    // No stderr.log: the scripted stderr is empty, so the file never appears.
    expect(Object.keys(files).sort()).toEqual(["answer.md", "chat-messages.json", "meta.json", "screen.txt"]);
    const meta = JSON.parse(files["meta.json"]) as ArchiveMeta;
    expect(meta.id).toBe(ids[0]);
    expect(meta.prompt).toBe(PROMPT);
    expect(meta.verdict).toBeNull();
    expect(meta.instancePid).toBe(4242);
    expect(meta.model).toBe("stub-model");
    expect(meta.target).toBeNull();
    expect(phaseNames(meta)).toEqual(["submitting", "working", "settling", "done"]);
    expectMonotone(meta);
    expect(meta.timings.startedAt).toBe(startedAt);
    expect(meta.timings.settledAt).toBe(Date.parse(meta.phaseLog[3].split("@")[1]));
    expect(meta.timings.elapsedMs).toBe(meta.timings.settledAt - meta.timings.startedAt);
    expect(files["answer.md"]).toBe(ANSWER);
    expect(files["screen.txt"]).toBe("settle frame\r\n");
    expect(files["chat-messages.json"]).toBe(scripted.logText);
  });

  test("non-empty driver stderr lands in stderr.log verbatim", async () => {
    scripted.stderr = "boom\r\n";
    scripted.afterPaste = ackAndEnd;

    const outcome = await drive(newRunner().run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });

    const [id] = archiveIds();
    expect(readArchive(id)["stderr.log"]).toBe("boom\r\n");
  });

  test.each([
    ["ack_missing", ["submitting", "failed"]],
    ["slot_held", ["submitting", "failed"]],
  ] as const)("failed settle (%s) archives with the Verdict and only the phases reached", async (verdict, expectedPhases) => {
    const runner = newRunner();
    if (verdict === "slot_held") scripted.settle = { ok: false, reason: "slot_held", excerpt: "held frame" };

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.verdict).toBe(verdict);

    const ids = archiveIds();
    expect(ids).toHaveLength(1);
    const files = readArchive(ids[0]);
    const meta = JSON.parse(files["meta.json"]) as ArchiveMeta;
    expect(meta.verdict).toBe(verdict);
    expect(meta.model).toBeNull();
    expect(meta.instancePid).toBe(4242);
    expect(phaseNames(meta)).toEqual([...expectedPhases]);
    expectMonotone(meta);
    expect(files["answer.md"]).toBe("");
    expect(Object.keys(files)).not.toContain("stderr.log");
  });

  test("a second settle adds an archive and never touches the first", async () => {
    scripted.afterPaste = ackAndEnd;
    const runner = newRunner();
    await drive(runner.run(PROMPT));
    const [first] = archiveIds();
    const before = readArchive(first);

    scripted.settle = { ok: true, state: "ready" };
    scripted.events = [];
    await drive(runner.run(PROMPT));

    expect(archiveIds()).toHaveLength(2);
    expect(readArchive(first)).toEqual(before);
  });

  test("a driver whose capture accessors throw still settles with the outcome untouched", async () => {
    class BrokenCaptureDriver extends ScriptedDriver {
      override async screenText(): Promise<string> {
        throw new Error("screen broken");
      }

      override chatLog(): string {
        throw new Error("chat broken");
      }

      override stderrText(): string {
        throw new Error("stderr broken");
      }
    }
    const broken = new BrokenCaptureDriver(clockSleep(clock));
    broken.afterPaste = () => {
      broken.ack(PROMPT);
      broken.endTurn(ANSWER);
    };

    const outcome = await drive(newRunner(undefined, broken).run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });

    const ids = archiveIds();
    expect(ids).toHaveLength(1);
    const files = readArchive(ids[0]);
    expect(Object.keys(files).sort()).toEqual(["answer.md", "chat-messages.json", "meta.json", "screen.txt"]);
    expect(files["screen.txt"]).toBe("");
    expect(files["chat-messages.json"]).toBe("");
    const meta = JSON.parse(files["meta.json"]) as ArchiveMeta;
    expect(meta.verdict).toBeNull();
    expect(phaseNames(meta)).toEqual(["submitting", "working", "settling", "done"]);
  });

  // -- Observation hooks for the async surface (#20 slice 1) -------------------

  test("onPhase fires submitting, working, settling in order and never after the run resolves", async () => {
    const seen: TurnPhase[] = [];
    scripted.afterPaste = ackAndEnd;
    const runner = newRunner(undefined, scripted, {
      onPhase: (phase) => {
        seen.push(phase);
      },
    });

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(seen).toEqual(["submitting", "working", "settling"]);
  });

  test("a throwing onPhase observer is contained: the run still settles ok", async () => {
    scripted.afterPaste = ackAndEnd;
    const runner = newRunner(undefined, scripted, {
      onPhase: () => {
        throw new Error("observer boom");
      },
    });

    const outcome = await drive(runner.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(existsSync(lockPath())).toBe(false);
  });

  test("taskId names the archive directory; without it an id is generated", async () => {
    scripted.afterPaste = ackAndEnd;
    const pinned = newRunner(undefined, scripted, { taskId: "task-20-slice-1" });

    const outcome = await drive(pinned.run(PROMPT));
    expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
    expect(archiveIds()).toEqual(["task-20-slice-1"]);
    const meta = JSON.parse(readArchive("task-20-slice-1")["meta.json"]) as ArchiveMeta;
    expect(meta.id).toBe("task-20-slice-1");

    // A runner without taskId keeps the generated-id behaviour.
    scripted.settle = { ok: true, state: "ready" };
    scripted.events = [];
    await drive(newRunner(undefined, scripted).run(PROMPT));
    const ids = archiveIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("task-20-slice-1");
  });

  test("archivePath rides the outcome on success and on no_answer when the archive wrote", async () => {
    scripted.afterPaste = ackAndEnd;
    const runner = newRunner();

    const ok = await drive(runner.run(PROMPT));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.archivePath).toBe(join(pluginDir, "tasks", archiveIds()[0]));
      expect(existsSync(ok.archivePath!)).toBe(true);
    }

    scripted.settle = { ok: true, state: "ready" };
    scripted.events = [];
    scripted.afterPaste = () => {
      scripted.ack(PROMPT);
      scripted.endTurn(null);
    };
    const failed = await drive(runner.run(PROMPT));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.verdict).toBe("no_answer");
      expect(failed.archivePath).toBe(join(pluginDir, "tasks", archiveIds().at(-1)!));
      expect(existsSync(failed.archivePath!)).toBe(true);
    }
  });

  test("instancePid and screenText expose the held driver, null before any run", async () => {
    const runner = newRunner();
    expect(runner.instancePid()).toBeNull();
    expect(await runner.screenText()).toBeNull();

    scripted.screen = "held frame";
    let pidMidRun: number | null | undefined;
    let screenMidRun: string | null | undefined;
    scripted.afterPaste = () => {
      pidMidRun = runner.instancePid();
      void runner.screenText().then((text) => {
        screenMidRun = text;
      });
      ackAndEnd();
    };

    await drive(runner.run(PROMPT));
    expect(pidMidRun).toBe(4242);
    expect(screenMidRun).toBe("held frame");
    // The instance is kept for reuse after a successful settle.
    expect(runner.instancePid()).toBe(4242);
    expect(await runner.screenText()).toBe("held frame");
  });

  // -- Watchdog (#21): deadline/frozen trips at the runner seam ----------------

  describe("watchdog (#21)", () => {
    // Ack then hang: the turn is confirmed working and never ends, so only the
    // watchdog can settle it.
    const hangAfterAck = (driver: ScriptedDriver): void => {
      driver.afterPaste = () => {
        driver.ack(PROMPT);
        driver.screen = WORKING_FRAME;
      };
    };

    test("deadline: hang after the Ack trips the deadline with an excerpt, kill and yield", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { deadlineMs: 30_000 } });
      hangAfterAck(scripted);

      const outcome = await drive(runner.run(PROMPT), 60_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.verdict).toBe("deadline");
        expect(outcome.message).toContain("watchdog failure: deadline");
        expect(outcome.screenExcerpt).toContain("thinking");
      }
      expect(scripted.calls.kill).toBe(1);
      expect(existsSync(lockPath())).toBe(false);
    });

    test("deadline arms at the confirmed Ack, not the submit: no trip while the ack windows run", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { deadlineMs: 1_000 } });
      scripted.afterPaste = () => {
        // The ack lands late in window 2 (~305ms in); the deadline measures from here.
        clock.setTimeout(() => scripted.ack(PROMPT), 300);
      };

      let settled = false;
      const run = runner.run(PROMPT).then((value) => {
        settled = true;
        return value;
      });
      // Past a submit-armed deadline (1s), still inside an Ack-armed one (~1.3s).
      await clock.advance(1_200);
      expect(settled).toBe(false);
      expect(scripted.calls.kill).toBe(0);

      const outcome = await drive(run, 10_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("deadline");
      expect(scripted.calls.kill).toBe(1);
    });

    test("frozen: a static store and screen after the Ack trip frozen with kill and yield", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { freezeMs: 300 } });
      hangAfterAck(scripted);

      const outcome = await drive(runner.run(PROMPT), 60_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.verdict).toBe("frozen");
        expect(outcome.message).toContain("watchdog failure: frozen");
        expect(outcome.screenExcerpt).toContain("thinking");
      }
      expect(scripted.calls.kill).toBe(1);
    });

    test("store growth resets the freeze clock: no frozen while the log grows, frozen once it stops", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { freezeMs: 300 } });
      hangAfterAck(scripted);

      let settled = false;
      const run = runner.run(PROMPT).then((value) => {
        settled = true;
        return value;
      });
      const growth = clock.setInterval(() => scripted.append({ chunk: "token" }), 50);
      await clock.advance(1_000);
      expect(settled).toBe(false);
      expect(scripted.calls.kill).toBe(0);
      clock.clearInterval(growth);

      // Silence from here: the accumulated stillness now trips frozen.
      const outcome = await drive(run, 60_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("frozen");
    });

    test("a real screen change resets the freeze clock even while the store is quiet", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { freezeMs: 300 } });
      hangAfterAck(scripted);

      let settled = false;
      const run = runner.run(PROMPT).then((value) => {
        settled = true;
        return value;
      });
      let token = 0;
      const churn = clock.setInterval(() => {
        token += 1;
        scripted.screen = `${WORKING_FRAME}\nstreaming token ${token}`;
      }, 50);
      await clock.advance(1_000);
      expect(settled).toBe(false);
      expect(scripted.calls.kill).toBe(0);
      clock.clearInterval(churn);

      const outcome = await drive(run, 60_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("frozen");
    });

    test("a countdown-only screen change never resets the freeze clock", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { freezeMs: 300 } });
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        scripted.screen = `${WORKING_FRAME}\n  2m left`;
      };
      // The raw screen keeps changing, but only in lines freezeKey strips.
      let minutes = 2;
      const countdown = clock.setInterval(() => {
        minutes = minutes === 2 ? 1 : 2;
        scripted.screen = `${WORKING_FRAME}\n  ${minutes}m left`;
      }, 50);

      const outcome = await drive(runner.run(PROMPT), 60_000);
      clock.clearInterval(countdown);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("frozen");
      expect(scripted.calls.kill).toBe(1);
    });

    test("a freeze tick that throws is contained: the watchdog keeps watching and still trips", async () => {
      class FlakyScreenDriver extends ScriptedDriver {
        failuresLeft = 0;
        override async screenText(): Promise<string> {
          if (this.failuresLeft > 0) {
            this.failuresLeft -= 1;
            throw new Error("screen hiccup");
          }
          return super.screenText();
        }
      }
      const flaky = new FlakyScreenDriver(clockSleep(clock));
      hangAfterAck(flaky);
      const runner = newRunner(undefined, flaky, { watchdog: { freezeMs: 300 } });
      // One broken read mid-watch; the interval must survive it.
      clock.setTimeout(() => {
        flaky.failuresLeft = 1;
      }, 150);

      const outcome = await drive(runner.run(PROMPT), 60_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("frozen");
      expect(flaky.calls.kill).toBe(1);
    });

    test("a paste into a dead child surfaces process_exited as crashed with kill and yield", async () => {
      class DyingPasteDriver extends ScriptedDriver {
        override async pastePrompt(_text: string): Promise<void> {
          throw new FreebuffDriverError("process_exited", "pty gone");
        }
      }
      const dying = new DyingPasteDriver(clockSleep(clock));
      const runner = newRunner(undefined, dying);

      const outcome = await drive(runner.run(PROMPT));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.verdict).toBe("crashed");
      expect(dying.calls.kill).toBe(1);
      expect(dying.isAlive).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });

    test("a settled run leaves no live watchdog: far advances write no second archive and never kill", async () => {
      const runner = newRunner(undefined, scripted, {
        watchdog: { deadlineMs: 30_000, freezeMs: 300 },
      });
      scripted.afterPaste = ackAndEnd;

      const outcome = await drive(runner.run(PROMPT));
      expect(outcome).toEqual({ ok: true, answer: ANSWER, archivePath: expect.any(String) });
      const ids = archiveIds();
      expect(ids).toHaveLength(1);

      await clock.advance(10 * 60_000);
      expect(archiveIds()).toEqual(ids);
      expect(scripted.calls.kill).toBe(0);
      expect(scripted.isAlive).toBe(true);
      expect(created).toBe(1);
    });
  });

  // -- Error log watcher (#21): screen error lines warn and log, never judge --

  describe("error log watcher (#21)", () => {
    const ERROR_LINE = "Command not found: bunx";
    const framesWith = (line: string): string => `${WORKING_FRAME}\n${line}`;
    // VirtualClock timers only: the error line appears after the watchdog arms
    // (its screen read is the baseline), raised deterministically on the clock.
    const raiseErrorAt = (driver: ScriptedDriver, atMs: number): void => {
      clock.setTimeout(() => {
        driver.screen = framesWith(ERROR_LINE);
      }, atMs);
    };

    const watchRunner = (): TurnRunner =>
      newRunner(undefined, scripted, { watchdog: { deadlineMs: 30_000, freezeMs: 5_000 } });

    test("an error line appearing after the Ack lands in warnings and in errors.jsonl", async () => {
      const runner = watchRunner();
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        raiseErrorAt(scripted, 100);
        clock.setTimeout(() => scripted.endTurn(ANSWER), 1_000);
      };

      const outcome = await drive(runner.run(PROMPT));
      if (!outcome.ok) throw new Error("expected success");
      expect(outcome.warnings).toEqual([ERROR_LINE]);

      const log = join(pluginDir, "errors.jsonl");
      expect(existsSync(log)).toBe(true);
      const entry = JSON.parse(readFileSync(log, "utf8")) as { time: string; workspace: string; lines: string[] };
      expect(entry.lines).toEqual([ERROR_LINE]);
      expect(entry.workspace).toBe(join(pluginDir, "ws"));
      expect(typeof entry.time).toBe("string");
    });

    test("a line already on screen at arm time is baseline and never warns", async () => {
      const runner = watchRunner();
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        scripted.screen = framesWith(ERROR_LINE);
        clock.setTimeout(() => scripted.endTurn(ANSWER), 1_000);
      };

      const outcome = await drive(runner.run(PROMPT));
      if (!outcome.ok) throw new Error("expected success");
      expect(outcome.warnings).toBeUndefined();
      expect(existsSync(join(pluginDir, "errors.jsonl"))).toBe(false);
    });

    test("scans wait for the arm-time baseline: a line present before it lands never warns", async () => {
      // The baseline read resolves after the first error tick (400 ms > 250 ms),
      // as a real PTY read under load can. Only a gated scan keeps the
      // pre-existing line from warning as new before the baseline arrives.
      class LateBaselineDriver extends ScriptedDriver {
        reads = 0;
        override async screenText(): Promise<string> {
          this.reads += 1;
          if (this.reads === 1) {
            return new Promise<string>((resolve) => {
              clock.setTimeout(() => void resolve(super.screenText()), 400);
            });
          }
          return super.screenText();
        }
      }
      const late = new LateBaselineDriver(clockSleep(clock));
      late.afterPaste = () => {
        late.ack(PROMPT);
        late.screen = framesWith(ERROR_LINE);
        clock.setTimeout(() => late.endTurn(ANSWER), 2_000);
      };
      const runner = newRunner(undefined, late, { watchdog: { deadlineMs: 30_000, freezeMs: 5_000 } });

      const outcome = await drive(runner.run(PROMPT));
      if (!outcome.ok) throw new Error("expected success");
      expect(outcome.warnings).toBeUndefined();
      expect(existsSync(join(pluginDir, "errors.jsonl"))).toBe(false);
    });

    test("one warning per line per run; a new run with a fresh baseline warns again", async () => {
      const runner = watchRunner();
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        raiseErrorAt(scripted, 100);
        clock.setTimeout(() => scripted.endTurn(ANSWER), 1_000);
      };
      const first = await drive(runner.run(PROMPT));
      if (!first.ok) throw new Error("expected success");
      expect(first.warnings).toEqual([ERROR_LINE]);

      // Success keeps the Instance (ADR-0001): the same driver runs the second
      // turn, its screen reset clean before the line reappears mid-run.
      expect(scripted.isAlive).toBe(true);
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        scripted.screen = WORKING_FRAME;
        raiseErrorAt(scripted, 100);
        clock.setTimeout(() => scripted.endTurn(ANSWER), 1_000);
      };
      const second = await drive(runner.run(PROMPT));
      if (!second.ok) throw new Error("expected success");
      expect(second.warnings).toEqual([ERROR_LINE]);

      const entries = readFileSync(join(pluginDir, "errors.jsonl"), "utf8").trim().split("\n");
      expect(entries).toHaveLength(2);
    });

    test("error lines never change the verdict: a frozen trip stays frozen with warnings attached", async () => {
      const runner = newRunner(undefined, scripted, { watchdog: { deadlineMs: 30_000, freezeMs: 300 } });
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        raiseErrorAt(scripted, 100);
      };

      const outcome = await drive(runner.run(PROMPT));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.verdict).toBe("frozen");
        expect(outcome.warnings).toEqual([ERROR_LINE]);
      }
      expect(scripted.calls.kill).toBe(1);
    });

    test("stop runs one final scan: a line visible only at settle time is still captured", async () => {
      const runner = watchRunner();
      scripted.afterPaste = () => {
        scripted.ack(PROMPT);
        clock.setTimeout(() => {
          scripted.screen = framesWith(ERROR_LINE);
          scripted.endTurn(ANSWER);
        }, 1_000);
      };

      const outcome = await drive(runner.run(PROMPT));
      if (!outcome.ok) throw new Error("expected success");
      expect(outcome.warnings).toEqual([ERROR_LINE]);
    });
  });
});
