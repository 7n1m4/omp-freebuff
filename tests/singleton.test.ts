// Ticket #20 slice 2: the process-scoped singleton's policy tier. Scripted
// drivers on a VirtualClock, a real lock file in temp dirs, no processes. The
// runner keeps its live driver across Tasks (ADR-0001), so createDriver fires
// only when no live driver exists; turn scripts are reassigned in place.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readLock, writeLock } from "../src/lock";
import { freebuffStatus } from "../src/status";
import {
  getFreebuffSingleton,
  peekFreebuffSingleton,
  resetFreebuffForTests,
  type FreebuffSingleton,
  type OwnerBinding,
  type ProgressDetails,
  type SettlePush,
  type SubmitOk,
} from "../src/singleton";
import type { TurnRunnerOptions } from "../src/turnRunner";
import { resolveTarget } from "../src/workspace";
import { driveGuard, driveReject, guard, pumpUntil, rejectionOf, type Guard } from "./helpers/guards";
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
// The shared implementations live in helpers/guards; each call passes the
// module-level clock, which beforeEach replaces with a fresh VirtualClock.

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
    const ok = await driveGuard(clock, guard(sing().submit(submitInput())));
    expect(ok.phase).toBe("working");
    expect(sing().statusExtra()).toEqual({
      queue: { depth: 0, taskIds: [] },
      activeTask: { taskId: ok.taskId, phase: "working" },
    });
    expect(pushes).toEqual([]);

    drivers[0].endTurn(ANSWER);
    await pumpUntil(clock, () => pushes.length === 1);
    expect(pushes[0]).toMatchObject({ taskId: ok.taskId, ok: true, answer: ANSWER });
  });

  test("concurrent submits queue FIFO; the fifth extra submit is refused busy at position 5", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(clock, guard(sing().submit(submitInput())));

    const queued: SubmitOk[] = [];
    for (let i = 0; i < 4; i++) queued.push(await sing().submit(submitInput()));
    expect(queued.map((r) => r.phase)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(queued.map((r) => (r.phase === "queued" ? r.position : -1))).toEqual([1, 2, 3, 4]);

    const busy = await rejectionOf(clock, sing().submit(submitInput()));
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

    const okFirst = await driveGuard(clock, guardFirst);
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
    const err = await driveReject(clock, guard(sing().submit(submitInput())));
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
    const ok = await driveGuard(clock, guard(sing().submit(submitInput())));
    await pumpUntil(clock, () => pushes.length === 1);

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
    const first = await driveGuard(clock, guard(sing().submit(submitInput())));
    const second = await sing().submit(submitInput());

    // The drained task reuses the live Instance (ADR-0001): re-script the same
    // driver in place for the second turn.
    drivers[0].afterPaste = () => {
      drivers[0].ack(PROMPT);
      drivers[0].endTurn(ANSWER);
    };
    drivers[0].endTurn(ANSWER);
    await pumpUntil(clock, () => {
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
    const first = await driveGuard(clock, guard(sing().submit(submitInput())));
    const other = bindingOf("session-other", "Other Session");
    const third = bindingOf("session-third", "Third Session");

    expect(await rejectionOf(clock, sing().submit(submitInput(other)))).toMatchObject({
      code: "not_owner",
      message: expect.stringContaining("Owner Session"),
    });
    expect(await rejectionOf(clock, sing().submit(submitInput(other)))).toEqual({
      code: "not_owner",
      message: expect.stringContaining("session-owner"),
    });
    expect(syncErr(() => progressOf(undefined, other))).toMatchObject({ code: "not_owner" });
    expect(await rejectionOf(clock, sing().screenText(other))).toMatchObject({ code: "not_owner" });
    expect(await rejectionOf(clock, sing().cancel(other))).toEqual({
      code: "not_owner",
      message: expect.stringContaining("Owner Session"),
    });

    // The owner's cancel settles the task cancelled through the same funnel as
    // any settle: archive, push, drained slot, released Lock.
    const cancelled = sing().cancel(owner);
    drivers[0].isAlive = false; // the ladder's kill lands
    expect(await driveGuard(clock, guard(cancelled))).toEqual({
      taskId: first.taskId,
      verdict: "cancelled",
      archivePath: join(pluginDir, "tasks", first.taskId),
    });
    expect(pushes[0]).toMatchObject({ taskId: first.taskId, ok: false, verdict: "cancelled" });

    expect(await rejectionOf(clock, sing().cancel(owner))).toMatchObject({ code: "no_active_task" });

    // A settled task is still its owner's answer: a third session is refused.
    expect(syncErr(() => progressOf(first.taskId, third))).toMatchObject({ code: "not_owner" });
    expect(progressOf(first.taskId, owner)).toMatchObject({ phase: "failed", verdict: "cancelled" });
  });

  test("an unsafe target is a caller mistake: bad_target at submit, nothing registered", async () => {
    const err = await rejectionOf(clock, sing().submit({ prompt: PROMPT, cwd: join(pluginDir, "ws"), binding: owner }));
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

    const ok = await driveGuard(clock, guardFirst);
    expect(paints[0]).toBe(`freebuff ${ok.taskId} · submitting · 0s · ${basename(target)}`);

    await clock.advance(1200);
    const last = paints.at(-1);
    expect(last).toBe(`freebuff ${ok.taskId} · working · 1s · ${basename(target)}`);
    expect(paints.some((line) => line !== undefined && line.includes(" · working · "))).toBe(true);

    drivers[0].endTurn(ANSWER);
    await pumpUntil(clock, () => paints.at(-1) === undefined);
    const count = paints.length;
    await clock.advance(300);
    expect(paints).toHaveLength(count);
  });

  test("bindingGone mid-flight: settles silently, queue still drains, recorded owner still gates", async () => {
    onCreated = ackSoon;
    const first = await driveGuard(clock, guard(sing().submit(submitInput())));
    const second = await sing().submit(submitInput());

    sing().bindingGone(owner.sessionId);
    // The gate keys on the recorded owner session id, which survives the gone
    // binding: a new session still cannot command the in-flight tasks.
    const intruder = bindingOf("session-intruder", "Intruder");
    expect(await rejectionOf(clock, sing().submit(submitInput(intruder)))).toMatchObject({ code: "not_owner" });

    // The drained task reuses the live Instance (ADR-0001): re-script in place.
    drivers[0].afterPaste = () => {
      drivers[0].ack(PROMPT);
      drivers[0].endTurn(ANSWER);
    };
    drivers[0].endTurn(ANSWER);
    await pumpUntil(clock, () => {
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
    const ok = await driveGuard(clock, guard(firstInstance.submit(submitInput())));
    await pumpUntil(clock, () => pushes.length === 1);

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

    const err = await driveReject(clock, guard(sing().submit(submitInput())));
    expect(err).toEqual({
      code: "lock_busy",
      message: expect.stringContaining("999999999"),
    });
    expect(drivers).toHaveLength(0);
    expect(sing().statusExtra().activeTask).toBeNull();
    expect(existsSync(join(pluginDir, "tasks"))).toBe(false);
    // The junction swap waits for the Lock (story 31): a claim that never
    // succeeded never re-pointed <workspace>/repo at this submit's Target.
    expect(existsSync(join(pluginDir, "ws", "repo"))).toBe(false);
    expect(progressOf(undefined)).toMatchObject({ phase: "failed", phaseSource: "verdict" });
    expect(progressOf(undefined).message).toContain("999999999");
  });

  test("a cancel whose run was abandoned by lock contention reports the abandonment, not cancelled", async () => {
    writeLock(pluginDir, {
      ownerPid: 999_999_999,
      instancePid: null,
      kind: "keeper",
      startedAt: new Date(clock.now()).toISOString(),
    });
    lockDepsOverride = { isPidAlive: () => true, deadlineMs: 100 };

    const submitted = guard(sing().submit(submitInput()));
    const cancelled = guard(sing().cancel(owner));
    expect(await driveReject(clock, cancelled)).toMatchObject({ code: "lock_busy" });
    expect(await submitted.promise).toMatchObject({ ok: false, error: { code: "lock_busy" } });
    expect(drivers).toHaveLength(0);
    expect(existsSync(join(pluginDir, "tasks"))).toBe(false);
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
      const ok = await driveGuard(clock, guard(sing().submit(submitInput())));
      expect(ok.phase).toBe("working");

      await pumpUntil(clock, () => pushes.length === 1);
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
      const first = await driveGuard(clock, guard(sing().submit(submitInput())));
      const second = await sing().submit(submitInput());

      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: first.taskId, ok: false, verdict: "deadline" });
      const atFirstSettle = clock.now();

      await pumpUntil(clock, () => pushes.length === 2);
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
      const ok = await driveGuard(clock, guard(sing().submit(submitInput())));

      await pumpUntil(clock, () => pushes.length === 1);
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
      const ok = await driveGuard(clock, guard(sing().submit(submitInput())));
      sing().bindingGone(owner.sessionId);

      await pumpUntil(clock, () => progressOf(ok.taskId).phase === "failed");
      expect(progressOf(ok.taskId, owner)).toMatchObject({ phase: "failed", verdict: "deadline" });
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(drivers[0].isAlive).toBe(false);
      expect(pushes).toEqual([]);
    });

    test("a fatal verdict drops the instance: the next task spawns a fresh driver", async () => {
      watchdogOverride = { deadlineMs: 1_000 };
      onCreated = hangAfterAck;
      const first = await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: first.taskId, verdict: "deadline" });
      expect(drivers[0].isAlive).toBe(false);

      const second = await driveGuard(clock, guard(sing().submit(submitInput())));
      expect(drivers).toHaveLength(2);
      expect(drivers[1]).not.toBe(drivers[0]);
      await pumpUntil(clock, () => pushes.length === 2);
      expect(pushes[1]).toMatchObject({ taskId: second.taskId, verdict: "deadline" });
    });

    test("no_answer leaves the instance live: the follow-up task reuses the same driver", async () => {
      onCreated = (driver) => {
        driver.afterPaste = () => {
          driver.ack(PROMPT);
          driver.endTurn(null);
        };
      };
      const first = await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ ok: false, verdict: "no_answer" });
      expect(drivers[0].isAlive).toBe(true);
      expect(drivers[0].calls.kill).toBe(0);

      drivers[0].afterPaste = () => {
        drivers[0].ack(PROMPT);
        drivers[0].endTurn(ANSWER);
      };
      const second = await driveGuard(clock, guard(sing().submit(submitInput())));
      expect(drivers).toHaveLength(1);
      await pumpUntil(clock, () => pushes.length === 2);
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
      const ok = await driveGuard(clock, guard(sing().submit(submitInput())));

      await pumpUntil(clock, () => pushes.length === 1);
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

  // -- Cancel and interrupt (#22): the three ladder targets and the detach rule

  describe("cancel and detach (#22)", () => {
    const PARTIAL = "singleton partial step";

    // An ack 60 ms after the paste, so the run parks in working with the turn
    // still in flight and the test can stop it from outside.
    const workingSubmit = async (): Promise<SubmitOk> => {
      onCreated = ackSoon;
      return await driveGuard(clock, guard(sing().submit(submitInput())));
    };

    const endAnswer = (driver: ScriptedDriver): void => {
      driver.afterPaste = () => {
        driver.ack(PROMPT);
        driver.endTurn(ANSWER);
      };
    };

    test("a cancel landing on a completing turn reports the completion, not cancelled", async () => {
      const first = await workingSubmit();
      clock.setTimeout(() => drivers[0].endTurn(ANSWER), 120);

      const result = await driveGuard(clock, guard(sing().cancel(owner)));
      expect(result).toEqual({
        taskId: first.taskId,
        verdict: "done",
        archivePath: join(pluginDir, "tasks", first.taskId),
      });
      // The settle was an ordinary success: the push carried the answer.
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId: first.taskId, ok: true, answer: ANSWER });
      expect(progressOf(first.taskId)).toMatchObject({ phase: "done", verdict: undefined });
    });

    test("active cancel: cancelled verdict, archive, push; the queued task drains on a fresh instance and the Lock is released", async () => {
      // The first driver parks in working (the cancel target); every later
      // driver completes its turn, so the queued task drains on its own.
      onCreated = (driver) => {
        if (drivers.length === 1) {
          driver.afterPaste = () => {
            clock.setTimeout(() => driver.ack(PROMPT), 60);
          };
        } else {
          endAnswer(driver);
        }
      };
      const first = await driveGuard(clock, guard(sing().submit(submitInput())));
      const second = await sing().submit(submitInput()); // queued behind the active task
      drivers[0].append({ shouldEndTurn: false, data: { fullResponse: PARTIAL } });

      const cancelled = sing().cancel(owner);
      drivers[0].isAlive = false; // the ladder's kill lands
      const result = await driveGuard(clock, guard(cancelled));

      expect(result).toEqual({
        taskId: first.taskId,
        verdict: "cancelled",
        archivePath: join(pluginDir, "tasks", first.taskId),
      });
      expect(pushes[0]).toMatchObject({
        taskId: first.taskId,
        ok: false,
        verdict: "cancelled",
        archivePath: result.archivePath,
      });
      expect(progressOf(first.taskId)).toMatchObject({ phase: "failed", phaseSource: "verdict", verdict: "cancelled" });
      expect(readFileSync(join(result.archivePath!, "answer.md"), "utf8")).toBe(PARTIAL);
      expect(JSON.parse(readFileSync(join(result.archivePath!, "meta.json"), "utf8"))).toMatchObject({
        verdict: "cancelled",
      });

      // The queue drains behind the cancel: the second task ran to completion
      // on a fresh instance, because the cancelled one was killed and dropped.
      await pumpUntil(clock, () => pushes.length === 2);
      expect(pushes[1]).toMatchObject({ taskId: second.taskId, ok: true, answer: ANSWER });
      expect(drivers).toHaveLength(2);

      // The Lock was released with each settle: a third submit claims it and
      // reuses the live instance.
      endAnswer(drivers[1]);
      const third = await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => progressOf(third.taskId).phase === "done");
      expect(progressOf(third.taskId)).toMatchObject({ phase: "done", answer: ANSWER });
      expect(drivers).toHaveLength(2);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
    });

    test("a double cancel resolves both awaits with the same result", async () => {
      const { taskId } = await workingSubmit();

      const first = guard(sing().cancel(owner));
      const second = guard(sing().cancel(owner));
      drivers[0].isAlive = false; // the ladder's kill lands
      const one = await driveGuard(clock, first);
      const two = await driveGuard(clock, second);
      expect(two).toEqual(one);
      expect(one).toMatchObject({ taskId, verdict: "cancelled" });
    });

    test("cancel during submit: the parked run call rejects naming the cancelled verdict and the push still fires", async () => {
      onCreated = (driver) => {
        driver.afterPaste = () => {}; // the paste lands, the ack never does
      };
      const submitted = guard(sing().submit(submitInput()));
      await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));

      await driveGuard(clock, guard(sing().cancel(owner)));
      expect(await driveReject(clock, submitted)).toMatchObject({
        code: "submit_failed",
        verdict: "cancelled",
        message: "task cancelled",
      });
      expect(pushes[0]).toMatchObject({ ok: false, verdict: "cancelled" });
      expect(drivers[0].isAlive).toBe(false);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);

      // The slot is free again: a follow-up submit runs to completion.
      onCreated = endAnswer;
      const next = await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => progressOf(next.taskId).phase === "done");
      expect(drivers).toHaveLength(2);
    });

    test("a user interrupt dequeues a queued task without ever spawning; the working one detaches", async () => {
      const first = await workingSubmit();
      const second = await sing().submit(submitInput());
      expect(drivers).toHaveLength(1);

      // ADR-0003: the abort detaches the working Task and cancels the queued
      // one outright — it never starts, never spawns, never archives.
      sing().interrupt(owner, "Interrupted by user");
      expect(sing().statusExtra()).toEqual({
        queue: { depth: 0, taskIds: [] },
        activeTask: { taskId: first.taskId, phase: "working" },
      });
      expect(syncErr(() => progressOf(second.taskId))).toMatchObject({ code: "unknown_task" });
      expect(drivers).toHaveLength(1);
      expect(existsSync(join(pluginDir, "tasks", second.taskId))).toBe(false);

      // The detached task was untouched and still delivers its own push.
      drivers[0].endTurn(ANSWER);
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes.map((push) => push.taskId)).toEqual([first.taskId]);
    });

    test("a cancel with nothing active is refused as no_active_task", async () => {
      onCreated = endAnswer;
      await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => sing().statusExtra().activeTask === null);
      expect(await rejectionOf(clock, sing().cancel(owner))).toMatchObject({ code: "no_active_task" });
    });

    test("a user interrupt while working detaches: the task runs to its real verdict and pushes", async () => {
      const { taskId } = await workingSubmit();

      sing().interrupt(owner, "Interrupted by user");
      expect(sing().statusExtra().activeTask).toEqual({ taskId, phase: "working" });
      drivers[0].endTurn(ANSWER);
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId, ok: true, answer: ANSWER });
      expect(progressOf(taskId)).toMatchObject({ phase: "done", answer: ANSWER });
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
    });

    test("the working progress carries the per-step feed: step, tools, partial answer, rendered blocks", async () => {
      const { taskId } = await workingSubmit();
      // No step line yet: the feed fields stay off the details.
      expect(progressOf(taskId)).not.toHaveProperty("steps");

      drivers[0].append({
        level: "DEBUG",
        msg: "End agent base3-free-catalog step 3 (id)",
        data: {
          shouldEndTurn: false,
          toolCalls: [{ toolName: "edit_file" }],
          toolResults: [{ toolName: "edit_file" }],
          fullResponse: "half the work is done",
        },
      });
      drivers[0].renderedBlockCounts[drivers[0].dirName] = 7;
      // The rendered read is the feed's slow cadence (≤5 s), so the pump runs
      // past the first sample point.
      await pumpUntil(clock, () => progressOf(taskId).blocks === 7, { budgetMs: 20_000 });
      expect(progressOf(taskId)).toMatchObject({
        steps: 3,
        lastToolCall: "edit_file",
        lastToolResult: "edit_file",
        partialAnswer: "half the work is done",
        blocks: 7,
      });

      // The feed rides only the active Task: another session's settled Task
      // (or a queued one) never carries a step sample.
      drivers[0].endTurn(ANSWER);
      await pumpUntil(clock, () => pushes.length === 1);
      expect(progressOf(taskId)).not.toHaveProperty("steps");
    });

    test.each(["Interrupted by user", "AbortError"] as const)(
      "an interrupt while submitting (%s) cancels the task",
      async (reason) => {
        onCreated = (driver) => {
          driver.afterPaste = () => {}; // the paste lands, the ack never does
        };
        const submitted = guard(sing().submit(submitInput()));
        await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));

        sing().interrupt(owner, reason);
        expect(await driveReject(clock, submitted)).toMatchObject({ code: "submit_failed", verdict: "cancelled" });
        expect(pushes[0]).toMatchObject({ ok: false, verdict: "cancelled" });
        expect(drivers[0].isAlive).toBe(false);
      },
    );

    test("an interrupt from a non-owner session leaves the owner's task alone", async () => {
      const { taskId } = await workingSubmit();
      const other = bindingOf("session-other", "Other Session");

      sing().interrupt(other, "Interrupted by user");
      sing().interrupt(other, "AbortError");
      expect(sing().statusExtra().activeTask).toEqual({ taskId, phase: "working" });
      drivers[0].endTurn(ANSWER);
      await pumpUntil(clock, () => pushes.length === 1);
      expect(pushes[0]).toMatchObject({ taskId, ok: true });
    });
  });

  // -- Session-death teardown (#23): the last session is gone ------------------

  describe("session-death teardown (#23)", () => {
    // Parks the run mid-submit: the paste lands, the ack never comes. The
    // submit stays pending until the test drives the clock again.
    const parkMidSubmit = (): Guard<SubmitOk> => {
      onCreated = (driver) => {
        driver.afterPaste = () => {};
      };
      return guard(sing().submit(submitInput()));
    };

    const archiveMetas = (): { dir: string; meta: Record<string, unknown> }[] => {
      const tasksDir = join(pluginDir, "tasks");
      if (!existsSync(tasksDir)) return [];
      return readdirSync(tasksDir).map((dir) => ({
        dir: join(tasksDir, dir),
        meta: JSON.parse(readFileSync(join(tasksDir, dir, "meta.json"), "utf8")) as Record<string, unknown>,
      }));
    };

    test("teardown kills and tombstones before deleting the lock: the abandoned archive is meta-only with verdict null", async () => {
      const submitted = parkMidSubmit();
      await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));
      const taskId = sing().statusExtra().activeTask!.taskId;
      let lockExistsAtKill: boolean | undefined;
      const realKill = drivers[0].kill.bind(drivers[0]);
      drivers[0].kill = () => {
        lockExistsAtKill = existsSync(join(pluginDir, "lock.json"));
        realKill();
      };

      await sing().teardown();

      // Kill-before-delete (ADR-0003): the Lock the claim took still stood when
      // the Instance died, and the tombstone outlives the deleted Lock.
      expect(lockExistsAtKill).toBe(true);
      expect(drivers[0].isAlive).toBe(false);
      expect(drivers[0].calls.kill).toBe(1);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      const archives = archiveMetas();
      expect(archives).toHaveLength(1);
      const { dir, meta } = archives[0]!;
      expect(meta).toMatchObject({ id: taskId, prompt: PROMPT, verdict: null });
      const phaseLog = meta.phaseLog as string[];
      expect(phaseLog.at(-1)).toContain("abandoned@");
      expect(phaseLog.at(-2)).toContain("submitting@");
      // Meta-only: the abandoned write carries no answer, chat store or screen.
      expect(readdirSync(dir)).toEqual(["meta.json"]);

      // The parked submit learns of the teardown; the unwind archives nothing
      // and pushes nothing.
      expect(await submitted.promise).toEqual({ ok: false, error: { code: "torn_down", message: expect.any(String) } });
      expect(await rejectionOf(clock, sing().submit(submitInput()))).toMatchObject({ code: "torn_down" });
      await clock.advance(2_000);
      expect(archiveMetas()).toHaveLength(1);
      expect(pushes).toEqual([]);
    });

    test("a queued task is dropped unarchived while the active one is abandoned", async () => {
      onCreated = ackSoon;
      const first = await driveGuard(clock, guard(sing().submit(submitInput())));
      const second = await sing().submit(submitInput());
      expect(second.phase).toBe("queued");

      await sing().teardown();

      const archives = archiveMetas();
      expect(archives).toHaveLength(1);
      expect(archives[0]!.meta).toMatchObject({ id: first.taskId, verdict: null });
      expect(existsSync(join(pluginDir, "tasks", second.taskId))).toBe(false);
      expect(drivers[0].isAlive).toBe(false);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(pushes).toEqual([]);
      await clock.advance(2_000);
      expect(archiveMetas()).toHaveLength(1);
    });

    test("a task parked on a foreign lock claim spawns nothing: one tombstone-only archive", async () => {
      writeLock(pluginDir, {
        ownerPid: 999_999_999,
        instancePid: null,
        kind: "keeper",
        startedAt: new Date(clock.now()).toISOString(),
      });
      lockDepsOverride = { isPidAlive: () => true, deadlineMs: 5_000 };
      const submitted = guard(sing().submit(submitInput()));
      await sing().teardown();

      // The claim never succeeded, so the phase log holds the tombstone alone.
      expect(drivers).toHaveLength(0);
      const archives = archiveMetas();
      expect(archives).toHaveLength(1);
      expect(archives[0]!.meta).toMatchObject({ verdict: null });
      expect(archives[0]!.meta.phaseLog).toEqual([expect.stringContaining("abandoned@")]);
      // Teardown deletes only the record this process holds: the foreign
      // claim is another window's live Lock, so it must survive intact. It
      // stays reclaimable by a fresh process's first claim, which classifies
      // it stale once its owner pid is gone (#17 composition; the fresh-start
      // describe below proves that reclaim end to end).
      expect(readLock(pluginDir)).toMatchObject({ ownerPid: 999_999_999, kind: "keeper" });
      expect(await driveReject(clock, submitted)).toMatchObject({ code: "torn_down" });

      // The unwinding claim runs to its end without spawning or writing again.
      await clock.advance(6_000);
      expect(drivers).toHaveLength(0);
      expect(archiveMetas()).toHaveLength(1);
    });

    test("a claimer taking the freed slot keeps its record: the unwinding release deletes only its own", async () => {
      const submitted = parkMidSubmit();
      await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));

      // Teardown frees the slot while the run is still parked inside its claim.
      await sing().teardown();
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      writeLock(pluginDir, {
        ownerPid: 999_999_999,
        instancePid: null,
        kind: "keeper",
        startedAt: new Date(clock.now()).toISOString(),
      });

      // The parked run unwinds and releases: a foreign Owner claimed the slot
      // in between, so the release must leave that fresh record alone.
      await clock.advance(2_000);
      expect(readLock(pluginDir)).toMatchObject({ ownerPid: 999_999_999, kind: "keeper" });
      expect(await submitted.promise).toMatchObject({ ok: false, error: { code: "torn_down" } });
      expect(archiveMetas()).toHaveLength(1);
      expect(drivers[0].isAlive).toBe(false);
    });

    test("a broken archive write still kills the driver and deletes the lock", async () => {
      // Any archive write throws: tasks/ exists as a file, so the mkdir under
      // it fails with ENOTDIR.
      writeFileSync(join(pluginDir, "tasks"), "not a directory");
      const submitted = parkMidSubmit();
      await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));

      await sing().teardown();

      expect(drivers[0].isAlive).toBe(false);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(await submitted.promise).toMatchObject({ ok: false, error: { code: "torn_down" } });
      await clock.advance(2_000);
      expect(pushes).toEqual([]);
    });

    test("teardown kills an idle instance and settles nothing; a second teardown is a no-op", async () => {
      onCreated = (driver) => {
        driver.afterPaste = () => {
          driver.ack(PROMPT);
          driver.endTurn(ANSWER);
        };
      };
      const ok = await driveGuard(clock, guard(sing().submit(submitInput())));
      await pumpUntil(clock, () => pushes.length === 1);
      expect(drivers[0].isAlive).toBe(true);

      await sing().teardown();
      await sing().teardown();

      expect(drivers[0].isAlive).toBe(false);
      expect(drivers[0].calls.kill).toBe(1);
      const archives = archiveMetas();
      expect(archives).toHaveLength(1);
      expect(archives[0]!.meta).toMatchObject({ id: ok.taskId, verdict: null });
      // The completed task's own archive keeps its real done tombstone.
      expect((archives[0]!.meta.phaseLog as string[]).at(-1)).toContain("done@");
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(pushes).toHaveLength(1);
    });

    test("teardown with no instance and no task writes nothing; later submits are refused as torn_down", async () => {
      // The shutdown trigger peeks: an absent singleton must stay absent.
      expect(peekFreebuffSingleton()).toBeUndefined();
      await sing().teardown();
      await sing().teardown();

      expect(existsSync(join(pluginDir, "tasks"))).toBe(false);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      expect(drivers).toHaveLength(0);
      expect(await rejectionOf(clock, sing().submit(submitInput()))).toMatchObject({ code: "torn_down" });
      expect(drivers).toHaveLength(0);
      expect(sing().statusExtra()).toEqual({ queue: { depth: 0, taskIds: [] }, activeTask: null });
    });
  });

  describe("fresh start after abandonment (#23)", () => {
    const FRESH_PROMPT = "fresh task after abandonment";
    const FRESH_ANSWER = "fresh answer";

    // Rig 1 parks a Task mid-submit and tears the process down, exactly like a
    // session death. Returns the abandoned archive's taskId.
    const abandonMidSubmit = async (): Promise<string> => {
      onCreated = (driver) => {
        driver.afterPaste = () => {};
      };
      const submitted = guard(sing().submit(submitInput()));
      await pumpUntil(clock, () => (drivers[0]?.events ?? []).some((entry) => entry.event === "paste"));
      const taskId = sing().statusExtra().activeTask!.taskId;
      const abandonAt = clock.now();
      await sing().teardown();
      await submitted.promise;
      lastAbandonAt = abandonAt;
      return taskId;
    };
    let lastAbandonAt = 0;

    test("a fresh start on the same plugin dir reports the abandoned task without spawning or resuming", async () => {
      const taskId = await abandonMidSubmit();
      const spawnsAfterRig1 = drivers.length;

      // Rig 2: a fresh singleton over the SAME pluginDir, like a restarted OMP
      // process that has never seen this Task.
      resetFreebuffForTests();
      const status = freebuffStatus({ pluginDir, freebuffConfigDir: join(pluginDir, "cfg") });

      expect(status.abandoned).toEqual([
        {
          taskId,
          prompt: PROMPT,
          target: resolve(repoDir),
          phase: "submitting",
          diedAt: new Date(lastAbandonAt).toISOString(),
        },
      ]);
      // Nothing resumed: no driver was created, no Task went active, nothing
      // was pushed; and time passing changes none of that.
      expect(drivers).toHaveLength(spawnsAfterRig1);
      expect(sing().statusExtra()).toEqual({ queue: { depth: 0, taskIds: [] }, activeTask: null });
      expect(pushes).toEqual([]);
      await clock.advance(2_000);
      expect(drivers).toHaveLength(spawnsAfterRig1);
      expect(pushes).toEqual([]);
    });

    test("the fresh start's first claim reclaims a stale lock and the new task leaves the abandoned archive untouched", async () => {
      const taskId = await abandonMidSubmit();
      const abandonedBytes = readFileSync(join(pluginDir, "tasks", taskId, "meta.json"));
      resetFreebuffForTests();

      // The Lock the dead rig never released reads as Stale: its owner pid died
      // with the process. #17's classify/reclaim must run on the fresh start's
      // first claim; the composition is exercised through the real run.
      writeLock(pluginDir, {
        ownerPid: 999_999_999,
        instancePid: null,
        kind: "keeper",
        startedAt: new Date(clock.now()).toISOString(),
      });
      lockDepsOverride = { isPidAlive: (pid) => pid === process.pid, deadlineMs: 5_000 };
      onCreated = (driver) => {
        driver.afterPaste = () => {
          driver.ack(FRESH_PROMPT);
        };
      };
      const fresh = await driveGuard(clock, guard(sing().submit({ prompt: FRESH_PROMPT, cwd: repoDir, binding: owner })));
      expect(fresh.phase).toBe("working");
      // Mid-run checkpoint: the reclaimed Lock names our pid, not the dead owner's.
      expect(readLock(pluginDir)).toMatchObject({ ownerPid: process.pid, kind: "extension" });

      drivers[1].endTurn(FRESH_ANSWER);
      await pumpUntil(clock, () => pushes.length >= 1);
      expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
      // Exactly one new driver: the fresh start spawned its own Instance for
      // the new Task; the abandoned Task was never resumed.
      expect(drivers).toHaveLength(2);
      // The abandoned archive stands byte-identical; the new Task settles into
      // its own archive with a real done@ tombstone.
      expect(readFileSync(join(pluginDir, "tasks", taskId, "meta.json"))).toEqual(abandonedBytes);
      const others = readdirSync(join(pluginDir, "tasks")).filter((name) => name !== taskId);
      expect(others).toHaveLength(1);
      const freshMeta = JSON.parse(readFileSync(join(pluginDir, "tasks", others[0]!, "meta.json"), "utf8")) as {
        prompt: string;
        verdict: string | null;
        phaseLog: string[];
      };
      expect(freshMeta.prompt).toBe(FRESH_PROMPT);
      expect(freshMeta.verdict).toBeNull();
      expect(freshMeta.phaseLog.at(-1)).toContain("done@");
      expect(pushes).toHaveLength(1);
    });
  });
});
