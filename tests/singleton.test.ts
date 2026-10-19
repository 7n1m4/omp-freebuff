// Ticket #20 slice 2: the process-scoped singleton's policy tier. Scripted
// drivers on a VirtualClock, a real lock file in temp dirs, no processes. The
// runner keeps its live driver across Tasks (ADR-0001), so createDriver fires
// only when no live driver exists; turn scripts are reassigned in place.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeLock } from "../src/lock";
import {
  getFreebuffSingleton,
  resetFreebuffForTests,
  type FreebuffSingleton,
  type OwnerBinding,
  type ProgressDetails,
  type SettlePush,
  type SubmitOk,
} from "../src/singleton";
import type { TurnRunnerOptions } from "../src/turnRunner";
import { resolveTarget } from "../src/workspace";
import { VirtualClock } from "./helpers/virtualClock";
import { ScriptedDriver } from "./helpers/scriptedDriver";

const TIMINGS = { settleMs: 200, ackMs: 200, pollMs: 25, pasteSettleMs: 5, pressThrottleMs: 50 };
const PROMPT = "hello singleton";
const ANSWER = "singleton answer 🚀 verbatim";

let pluginDir = "";
let repoDir = "";
let clock: VirtualClock;
let drivers: ScriptedDriver[];
let paints: (string | undefined)[];
let pushes: SettlePush[];
let owner: OwnerBinding;
let onCreated: (driver: ScriptedDriver) => void;
let driverFactory: () => ScriptedDriver;
let lockDepsOverride: TurnRunnerOptions["lockDeps"];
let watchdogOverride: TurnRunnerOptions["watchdog"];
let paintTickMsOverride: number | undefined;

const clockSleep = (virtual: VirtualClock) => (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  virtual.setTimeout(resolve, ms);
  return promise;
};

const bindingOf = (sessionId: string, label: string): OwnerBinding => ({
  sessionId,
  label,
  hasUI: true,
  paint: (line) => {
    paints.push(line);
  },
  push: (payload) => {
    pushes.push(payload);
  },
});

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "singleton-"));
  // A sibling of pluginDir: the workspace lives at pluginDir/ws, so pluginDir
  // itself is an unsafe target and every legit submit needs a separate dir.
  repoDir = mkdtempSync(join(tmpdir(), "singleton-repo-"));
  clock = new VirtualClock();
  drivers = [];
  paints = [];
  pushes = [];
  owner = bindingOf("session-owner", "Owner Session");
  onCreated = () => {};
  driverFactory = () => new ScriptedDriver(clockSleep(clock));
  lockDepsOverride = undefined;
  watchdogOverride = undefined;
  paintTickMsOverride = undefined;
  resetFreebuffForTests();
});

afterEach(() => {
  resetFreebuffForTests();
  rmSync(pluginDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

const newDriver = (): ScriptedDriver => {
  const driver = driverFactory();
  drivers.push(driver);
  onCreated(driver);
  return driver;
};

const sing = (): FreebuffSingleton =>
  getFreebuffSingleton(() => ({
    runner: {
      pluginDir,
      workspace: join(pluginDir, "ws"),
      freebuffConfigDir: join(pluginDir, "cfg"),
      command: { application: "freebuff-never-spawned" },
      timings: TIMINGS,
      clock,
      lockDeps: lockDepsOverride ?? { deadlineMs: 5_000 },
      watchdog: watchdogOverride,
      createDriver: async () => {
        const driver = newDriver();
        driver.started();
        return driver;
      },
    },
    tick: { now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval },
    paintTickMs: paintTickMsOverride ?? 1000,
  }));

const submitInput = (binding: OwnerBinding = owner) => ({ prompt: PROMPT, cwd: repoDir, binding });
const progressOf = (taskId: string | undefined, binding: OwnerBinding = owner): ProgressDetails =>
  sing().progress(taskId, binding);

// The ack must land while the run is between its baseline and its deadline, so
// it is scripted ON the virtual clock from inside the run instead of being
// typed by the test at an arbitrary microtask boundary.
const ackSoon = (driver: ScriptedDriver): void => {
  driver.afterPaste = () => {
    clock.setTimeout(() => {
      driver.ack(PROMPT);
    }, 60);
  };
};

// -- virtual-time guards ------------------------------------------------------

type Guard<T> = {
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
  done(): boolean;
};

const guard = <T>(p: Promise<T>): Guard<T> => {
  let settled = false;
  const promise = p.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return { promise, done: () => settled };
};

// Drives an already-guarded promise to completion on the virtual clock: timers
// only fire inside advance, and each advance flushes awaited continuations.
const driveGuard = async <T>(g: Guard<T>, budgetMs = 60_000): Promise<T> => {
  const end = clock.now() + budgetMs;
  while (!g.done() && clock.now() < end) await clock.advance(25);
  if (!g.done()) throw new Error("virtual time budget exhausted before the promise settled");
  const result = await g.promise;
  if (!result.ok) throw result.error;
  return result.value;
};

const driveReject = async (g: Guard<unknown>, budgetMs = 60_000): Promise<unknown> => {
  const end = clock.now() + budgetMs;
  while (!g.done() && clock.now() < end) await clock.advance(25);
  if (!g.done()) throw new Error("virtual time budget exhausted before the promise settled");
  const result = await g.promise;
  if (result.ok) throw new Error("expected rejection");
  return result.error;
};

// For rejections that need no virtual time (immediate refusals).
const rejectionOf = async (p: Promise<unknown>): Promise<unknown> => driveReject(guard(p));

const pumpUntil = async (predicate: () => boolean, budgetMs = 60_000): Promise<void> => {
  const end = clock.now() + budgetMs;
  while (!predicate()) {
    if (clock.now() >= end) throw new Error("virtual time budget exhausted");
    await clock.advance(25);
  }
};

const syncErr = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("FreebuffSingleton (process-scoped, scripted drivers, virtual clock)", () => {
  test("submit resolves working while the turn is still in flight", async () => {
    onCreated = ackSoon;
    const ok = await driveGuard(guard(sing().submit(submitInput())));
    expect(ok.phase).toBe("working");
    expect(sing().statusExtra()).toEqual({
      queue: { depth: 0, taskIds: [] },
      activeTask: { taskId: ok.taskId, phase: "working" },
    });
    expect(pushes).toEqual([]);

    drivers[0].endTurn(ANSWER);
    await pumpUntil(() => pushes.length === 1);
    expect(pushes[0]).toMatchObject({ taskId: ok.taskId, ok: true, answer: ANSWER });
  });

  test("concurrent submits queue FIFO; the fifth extra submit is refused busy at position 5", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(guard(sing().submit(submitInput())));

    const queued: SubmitOk[] = [];
    for (let i = 0; i < 4; i++) queued.push(await sing().submit(submitInput()));
    expect(queued.map((r) => r.phase)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(queued.map((r) => (r.phase === "queued" ? r.position : -1))).toEqual([1, 2, 3, 4]);

    const busy = await rejectionOf(sing().submit(submitInput()));
    expect(busy).toMatchObject({ code: "busy", busy: true, position: 5 });
    expect(sing().statusExtra().queue).toEqual({ depth: 4, taskIds: queued.map((r) => r.taskId) });
    expect(sing().statusExtra().activeTask).toEqual({ taskId: first.taskId, phase: "working" });
  });

  test("all six phases observable with their fixed phaseSource", async () => {
    // The slow screen read suspends the run's tail on the virtual clock, so
    // settling stays observable between advances.
    const sleep = clockSleep(clock);
    class SlowScreenDriver extends ScriptedDriver {
      override async screenText(): Promise<string> {
        await sleep(50);
        return super.screenText();
      }
    }
    driverFactory = () => new SlowScreenDriver(sleep);
    onCreated = ackSoon;

    const first = sing().submit(submitInput());
    const guardFirst = guard(first);
    await clock.advance(25);
    expect(progressOf(undefined)).toMatchObject({ phase: "submitting", phaseSource: "step-state" });

    const second = await sing().submit(submitInput());
    expect(second).toEqual({ taskId: second.taskId, phase: "queued", position: 1 });
    expect(progressOf(second.taskId)).toMatchObject({
      phase: "queued",
      phaseSource: "step-state",
      position: 1,
    });

    const okFirst = await driveGuard(guardFirst);
    expect(okFirst).toEqual({ taskId: okFirst.taskId, phase: "working" });
    expect(progressOf(okFirst.taskId)).toMatchObject({ phase: "working", phaseSource: "chat-store" });

    drivers[0].endTurn(ANSWER);
    await clock.advance(25);
    expect(progressOf(okFirst.taskId)).toMatchObject({ phase: "settling", phaseSource: "step-state" });

    // The drained second task reuses the live Instance (ADR-0001): the same
    // driver serves the next turn, so its script is reassigned in place.
    drivers[0].afterPaste = () => {
      drivers[0].ack(PROMPT);
      drivers[0].endTurn(ANSWER);
    };
    // Settling now ends with the watcher's final screen scan plus the archive
    // read, two slow reads on this driver, so give the tail 150ms.
    await clock.advance(150);
    expect(progressOf(okFirst.taskId)).toMatchObject({
      phase: "done",
      phaseSource: "verdict",
      answer: ANSWER,
    });
    await clock.advance(200);
    expect(progressOf(second.taskId)).toMatchObject({
      phase: "done",
      phaseSource: "verdict",
      answer: ANSWER,
    });
    expect(pushes.map((push) => push.taskId)).toEqual([okFirst.taskId, second.taskId]);
    // One driver for both turns: the Instance is reused, not respawned (ADR-0001).
    expect(drivers).toHaveLength(1);

    // A task that settles before the ack fails under its Verdict; the reused
    // driver's settle outcome is pointed at the failure in place.
    drivers[0].settle = { ok: false, reason: "slot_held", excerpt: "held frame" };
    const err = await driveReject(guard(sing().submit(submitInput())));
    expect(err).toMatchObject({ code: "submit_failed", verdict: "slot_held" });
    expect(progressOf(undefined)).toMatchObject({
      phase: "failed",
      phaseSource: "verdict",
      verdict: "slot_held",
    });
  });

  test("settle push carries the verbatim answer once; progress repeats it; archive pins the submit-time id", async () => {
    onCreated = (driver) => {
      driver.afterPaste = () => {
        driver.ack(PROMPT);
        driver.endTurn(ANSWER);
      };
    };
    const ok = await driveGuard(guard(sing().submit(submitInput())));
    await pumpUntil(() => pushes.length === 1);

    const push = pushes[0];
    expect(push.taskId).toBe(ok.taskId);
    expect(push.ok).toBe(true);
    expect(push.answer).toBe(ANSWER);
    if (push.archivePath === undefined) throw new Error("the settle push carried no archivePath");
    const archivePath = push.archivePath;
    expect(archivePath).toBe(join(pluginDir, "tasks", ok.taskId));
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(join(archivePath, "answer.md"), "utf8")).toBe(ANSWER);
    const meta = JSON.parse(readFileSync(join(archivePath, "meta.json"), "utf8")) as { id: string };
    expect(meta.id).toBe(ok.taskId);

    expect(progressOf(ok.taskId)).toMatchObject({
      phase: "done",
      phaseSource: "verdict",
      answer: ANSWER,
      archivePath,
    });
    expect(pushes).toHaveLength(1);
  });

  test("after a settle the next queued task activates automatically and pushes its own answer", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(guard(sing().submit(submitInput())));
    const second = await sing().submit(submitInput());

    // The drained task reuses the live Instance (ADR-0001): re-script the same
    // driver in place for the second turn.
    drivers[0].afterPaste = () => {
      drivers[0].ack(PROMPT);
      drivers[0].endTurn(ANSWER);
    };
    drivers[0].endTurn(ANSWER);
    await pumpUntil(() => {
      const status = sing().statusExtra();
      return status.activeTask === null && status.queue.depth === 0;
    });

    expect(drivers).toHaveLength(1);
    expect(pushes.map((push) => push.taskId)).toEqual([first.taskId, second.taskId]);
    expect(pushes[1]).toMatchObject({ ok: true, answer: ANSWER });
    expect(progressOf(second.taskId).phase).toBe("done");
  });

  test("non-owner sessions are refused at submit, progress, screen and cancel; answers stay owner-scoped", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(guard(sing().submit(submitInput())));
    const other = bindingOf("session-other", "Other Session");
    const third = bindingOf("session-third", "Third Session");

    expect(await rejectionOf(sing().submit(submitInput(other)))).toMatchObject({
      code: "not_owner",
      message: expect.stringContaining("Owner Session"),
    });
    expect(await rejectionOf(sing().submit(submitInput(other)))).toEqual({
      code: "not_owner",
      message: expect.stringContaining("session-owner"),
    });
    expect(syncErr(() => progressOf(undefined, other))).toMatchObject({ code: "not_owner" });
    expect(await rejectionOf(sing().screenText(other))).toMatchObject({ code: "not_owner" });
    expect(syncErr(() => sing().cancel(other))).toMatchObject({ code: "not_owner" });

    expect(syncErr(() => sing().cancel(owner))).toMatchObject({ code: "cancel_not_implemented" });

    drivers[0].endTurn(ANSWER);
    await pumpUntil(() => sing().statusExtra().activeTask === null);
    expect(syncErr(() => sing().cancel(owner))).toMatchObject({ code: "no_active_task" });

    // A settled task is still its owner's answer: a third session is refused.
    expect(syncErr(() => progressOf(first.taskId, third))).toMatchObject({ code: "not_owner" });
    expect(progressOf(first.taskId, owner)).toMatchObject({ phase: "done", answer: ANSWER });
  });

  test("an unsafe target is a caller mistake: bad_target at submit, nothing registered", async () => {
    const err = await rejectionOf(sing().submit({ prompt: PROMPT, cwd: join(pluginDir, "ws"), binding: owner }));
    expect(err).toMatchObject({ code: "bad_target" });
    expect(sing().statusExtra()).toEqual({ queue: { depth: 0, taskIds: [] }, activeTask: null });
    expect(syncErr(() => progressOf(undefined))).toMatchObject({ code: "unknown_task" });
    expect(drivers).toHaveLength(0);
  });

  test("the process-scoped paint tick names taskId, phase, elapsed and target; cleared on settle", async () => {
    paintTickMsOverride = 100;
    const target = resolveTarget(repoDir);
    // The ack lands after the first paint tick, so the submitting phase is on
    // the recorded line.
    onCreated = (driver) => {
      driver.afterPaste = () => {
        clock.setTimeout(() => {
          driver.ack(PROMPT);
        }, 150);
      };
    };
    const first = sing().submit(submitInput());
    const guardFirst = guard(first);

    await clock.advance(100);
    expect(paints).toHaveLength(1);

    const ok = await driveGuard(guardFirst);
    expect(paints[0]).toBe(`freebuff ${ok.taskId} · submitting · 0s · ${basename(target)}`);

    await clock.advance(1200);
    const last = paints.at(-1);
    expect(last).toBe(`freebuff ${ok.taskId} · working · 1s · ${basename(target)}`);
    expect(paints.some((line) => line !== undefined && line.includes(" · working · "))).toBe(true);

    drivers[0].endTurn(ANSWER);
    await pumpUntil(() => paints.at(-1) === undefined);
    const count = paints.length;
    await clock.advance(300);
    expect(paints).toHaveLength(count);
  });

  test("bindingGone mid-flight: settles silently, queue still drains, recorded owner still gates", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(guard(sing().submit(submitInput())));
    const second = await sing().submit(submitInput());

    sing().bindingGone(owner.sessionId);
    // The gate keys on the recorded owner session id, which survives the gone
    // binding: a new session still cannot command the in-flight tasks.
    const intruder = bindingOf("session-intruder", "Intruder");
    expect(await rejectionOf(sing().submit(submitInput(intruder)))).toMatchObject({ code: "not_owner" });

    // The drained task reuses the live Instance (ADR-0001): re-script in place.
    drivers[0].afterPaste = () => {
      drivers[0].ack(PROMPT);
      drivers[0].endTurn(ANSWER);
    };
    drivers[0].endTurn(ANSWER);
    await pumpUntil(() => {
      const status = sing().statusExtra();
      return status.activeTask === null && status.queue.depth === 0;
    });

    expect(pushes).toEqual([]);
    expect(progressOf(first.taskId, owner).phase).toBe("done");
    expect(progressOf(second.taskId, owner).phase).toBe("done");
    expect(drivers).toHaveLength(1);
    expect(sing()).toBe(sing());
  });

  test("resetFreebuffForTests clears memoization, registry and queue", async () => {
    onCreated = (driver) => {
      driver.afterPaste = () => {
        driver.ack(PROMPT);
        driver.endTurn(ANSWER);
      };
    };
    const firstInstance = sing();
    const ok = await driveGuard(guard(firstInstance.submit(submitInput())));
    await pumpUntil(() => pushes.length === 1);

    resetFreebuffForTests();
    const secondInstance = sing();
    expect(secondInstance).not.toBe(firstInstance);
    expect(secondInstance.statusExtra()).toEqual({ queue: { depth: 0, taskIds: [] }, activeTask: null });
    expect(syncErr(() => secondInstance.progress(undefined, owner))).toMatchObject({ code: "unknown_task" });
    expect(syncErr(() => secondInstance.progress(ok.taskId, owner))).toMatchObject({ code: "unknown_task" });
  });

  test("cross-owner lock contention rejects submit with lock_busy naming the holder", async () => {
    writeLock(pluginDir, {
      ownerPid: 999_999_999,
      instancePid: null,
      kind: "keeper",
      startedAt: new Date(clock.now()).toISOString(),
    });
    lockDepsOverride = { isPidAlive: () => true, deadlineMs: 100 };

    const err = await driveReject(guard(sing().submit(submitInput())));
    expect(err).toEqual({
      code: "lock_busy",
      message: expect.stringContaining("999999999"),
    });
    expect(drivers).toHaveLength(0);
    expect(sing().statusExtra().activeTask).toBeNull();
    expect(existsSync(join(pluginDir, "tasks"))).toBe(false);
    expect(progressOf(undefined)).toMatchObject({ phase: "failed", phaseSource: "verdict" });
    expect(progressOf(undefined).message).toContain("999999999");
  });

  // -- Watchdog integration (#21): verdicts, lock release and warnings end-to-end

  describe("watchdog integration (#21)", () => {
    // Ack then never end: the turn is confirmed working, so only the watchdog
    // settles it.
    const hangAfterAck = (driver: ScriptedDriver): void => {
      driver.afterPaste = () => {
        driver.ack(PROMPT);
      };
    };

    test("a hung task trips deadline: failed, lock released, driver killed, push carries the verdict", async () => {
      watchdogOverride = { deadlineMs: 2_000 };
      onCreated = hangAfterAck;
      const ok = await driveGuard(guard(sing().submit(submitInput())));
      expect(ok.phase).toBe("working");

      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({
        taskId: ok.taskId,
        ok: false,
        verdict: "deadline",
        message: expect.stringContaining("watchdog failure: deadline"),
      });
      expect(progressOf(ok.taskId)).toMatchObject({ phase: "failed", phaseSource: "verdict", verdict: "deadline" });
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(drivers[0].isAlive).toBe(false);
      expect(drivers[0].calls.kill).toBe(1);
    });

    test("a queued task is measured from its own ack, not its submission", async () => {
      watchdogOverride = { deadlineMs: 2_000 };
      onCreated = hangAfterAck;
      const first = await driveGuard(guard(sing().submit(submitInput())));
      const second = await sing().submit(submitInput());

      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: first.taskId, ok: false, verdict: "deadline" });
      const atFirstSettle = clock.now();

      await pumpUntil(() => pushes.length === 2);
      expect(pushes[1]).toMatchObject({ taskId: second.taskId, ok: false, verdict: "deadline" });
      // From its own ack (~60ms after activation) the trip takes a full
      // deadline; measured from submission instead, task 2 would have settled
      // together with task 1.
      expect(clock.now() - atFirstSettle).toBeGreaterThanOrEqual(1_500);
      expect(pushes[1].elapsedMs).toBeGreaterThanOrEqual(1_900);
    });

    test("a frozen task settles failed frozen; the push carries screenExcerpt and no warnings", async () => {
      watchdogOverride = { deadlineMs: 30_000, freezeMs: 300 };
      onCreated = hangAfterAck;
      const ok = await driveGuard(guard(sing().submit(submitInput())));

      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: ok.taskId, ok: false, verdict: "frozen" });
      expect(typeof pushes[0].screenExcerpt).toBe("string");
      expect(pushes[0].warnings).toBeUndefined();
      expect(progressOf(ok.taskId)).toMatchObject({
        phase: "failed",
        verdict: "frozen",
        screenExcerpt: expect.any(String),
      });
      expect(drivers[0].calls.kill).toBe(1);
    });

    test("a gone binding still sees the task settle deadline on its record, silently", async () => {
      watchdogOverride = { deadlineMs: 2_000 };
      onCreated = hangAfterAck;
      const ok = await driveGuard(guard(sing().submit(submitInput())));
      sing().bindingGone(owner.sessionId);

      await pumpUntil(() => progressOf(ok.taskId).phase === "failed");
      expect(progressOf(ok.taskId, owner)).toMatchObject({ phase: "failed", verdict: "deadline" });
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(drivers[0].isAlive).toBe(false);
      expect(pushes).toEqual([]);
    });

    test("a fatal verdict drops the instance: the next task spawns a fresh driver", async () => {
      watchdogOverride = { deadlineMs: 1_000 };
      onCreated = hangAfterAck;
      const first = await driveGuard(guard(sing().submit(submitInput())));
      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: first.taskId, verdict: "deadline" });
      expect(drivers[0].isAlive).toBe(false);

      const second = await driveGuard(guard(sing().submit(submitInput())));
      expect(drivers).toHaveLength(2);
      expect(drivers[1]).not.toBe(drivers[0]);
      await pumpUntil(() => pushes.length === 2);
      expect(pushes[1]).toMatchObject({ taskId: second.taskId, verdict: "deadline" });
    });

    test("no_answer leaves the instance live: the follow-up task reuses the same driver", async () => {
      onCreated = (driver) => {
        driver.afterPaste = () => {
          driver.ack(PROMPT);
          driver.endTurn(null);
        };
      };
      const first = await driveGuard(guard(sing().submit(submitInput())));
      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ ok: false, verdict: "no_answer" });
      expect(drivers[0].isAlive).toBe(true);
      expect(drivers[0].calls.kill).toBe(0);

      drivers[0].afterPaste = () => {
        drivers[0].ack(PROMPT);
        drivers[0].endTurn(ANSWER);
      };
      const second = await driveGuard(guard(sing().submit(submitInput())));
      expect(drivers).toHaveLength(1);
      await pumpUntil(() => pushes.length === 2);
      expect(pushes[1]).toMatchObject({ taskId: second.taskId, ok: true, answer: ANSWER });
    });

    test("an error-log hit surfaces through the singleton: warnings in the push and progress", async () => {
      const ERROR_LINE = "Command not found: bunx";
      onCreated = (driver) => {
        driver.afterPaste = () => {
          driver.ack(PROMPT);
          // VirtualClock timers: the line appears after the watcher arms, well
          // before the turn ends.
          clock.setTimeout(() => {
            driver.screen = ERROR_LINE;
          }, 100);
          clock.setTimeout(() => driver.endTurn(ANSWER), 1_500);
        };
      };
      const ok = await driveGuard(guard(sing().submit(submitInput())));

      await pumpUntil(() => pushes.length === 1);
      expect(pushes[0]).toMatchObject({
        taskId: ok.taskId,
        ok: true,
        answer: ANSWER,
        warnings: [ERROR_LINE],
      });
      expect(progressOf(ok.taskId)).toMatchObject({ phase: "done", warnings: [ERROR_LINE] });

      const entry = JSON.parse(readFileSync(join(pluginDir, "errors.jsonl"), "utf8")) as {
        time: string;
        workspace: string;
        lines: string[];
      };
      expect(entry.lines).toEqual([ERROR_LINE]);
      expect(entry.workspace).toBe(join(pluginDir, "ws"));
    });
  });
});
