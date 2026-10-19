// Ticket #20 slice 3, harness tier: the five-tool surface (src/index.ts) driven
// end to end through real agent sessions against the stub child over a real
// PTY, on the process-scoped singleton (ADR-0004). One test per acceptance
// criterion; each test owns a fresh rig (temp plugin/config/workspace dirs +
// PI_FREEBUFF_RUNNER_JSON) and a fresh singleton.
//
// Phase observation that must outrun a model round-trip polls the singleton
// directly through the same public seam the tool uses (progress + a binding
// carrying the session's real id); everything else goes through the model.
//
// The polling loops sleep on the wall clock on purpose: the counterpart is a
// real child process behind a real PTY, which fake timers cannot advance.
//
// Verdict reachability (the nine-set): every verdict a run can settle with is
// proven at the highest practical tier, and the shared failed-result rendering
// is proven once e2e in the deadline test.
// - deadline: "a wedged task trips the deadline watchdog" (below); policy:
//   singleton.test.ts "a hung task trips deadline"
// - frozen: "a static task trips the freeze watchdog" (below); policy:
//   singleton.test.ts "a frozen task settles failed frozen"
// - crashed: "a mid-turn crash settles as crashed" (below); PTY: task.test.ts
//   "crashed"; policy: turnRunner.test.ts "driver dies mid-turn"
// - ack_missing: "an unacked submit lands as ack_missing" (below); PTY:
//   task.test.ts "ack_missing"; policy: turnRunner.test.ts "no ack signals"
// - no_answer: "a no-answer failure leaves the instance live" (below) + "a
//   failed task settles under its verdict" (below); PTY: task.test.ts
//   "no-answer"; policy: turnRunner.test.ts "turn ends without an answer"
// - slot_held: the test.each settle-frame block (below); PTY: task.test.ts
//   "slot_held"; policy: turnRunner.test.ts settle-mapping test.each and
//   singleton.test.ts "a settle that fails slot_held"
// - displaced: the test.each settle-frame block (below); driver tier:
//   driver.test.ts "displaced"; policy: turnRunner.test.ts settle mapping
// - driver_error: the test.each settle-frame block (below, the unknown frame);
//   policy: turnRunner.test.ts settle mapping (needs_login, ready_timeout)
// - cancelled: "freebuff_cancel stops the working task" (below); policy:
//   singleton.test.ts "cancel and detach (#22)"; PTY: task.test.ts "cancel
//   ladder over the stub child (#22)"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import freebuff from "../src/index";
import { killInstance, pidAlive } from "../src/lock";
import type { FreebuffSingleton, OwnerBinding, ProgressDetails, SettlePush, SubmitOk } from "../src/singleton";
import { getFreebuffSingleton, resetFreebuffForTests } from "../src/singleton";
import type { TurnRunnerOptions } from "../src/turnRunner";
import { createHarnessSession, type Harness } from "./helpers/sdkHarness";
import { eventsOf, kindsOf, readInputLog } from "./helpers/stubInputLog";

const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const TIMINGS = { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 };
const PROMPT = "probe the freebuff surface";
const ANSWER = `stub(DeepSeek V4.1 Flash): ${PROMPT}`;
// The settle push starts its own turn on an idle session; spare plain replies
// keep those turns fed no matter where they land.
const SPARES: MockResponse[] = [{ content: ["ack"] }, { content: ["ack"] }, { content: ["ack"] }];

// Structured refusals are plain objects thrown by the singleton; the surface
// passes them through as tool-result details.
interface RejectionDetails {
  code: string;
  message: string;
  busy?: boolean;
  position?: number;
}

// The merged freebuff_status details: base diagnostics (src/status.ts) plus
// the singleton's queue/activeTask extra.
interface StatusDetails {
  lock: { state: string };
  instancePid?: number;
  target?: string;
  foreign: { live: unknown[] };
  archive: { count: number };
  queue: { depth: number; taskIds: string[] };
  activeTask: { taskId: string; phase: string } | null;
}

interface ScreenDetails {
  taskId?: string;
}

const runCall = (prompt: string): MockResponse[] => [
  { content: [{ type: "toolCall", name: "freebuff_run", arguments: { prompt } }] },
  { content: ["submitted"] },
];
const progressCall = (): MockResponse[] => [
  { content: [{ type: "toolCall", name: "freebuff_progress", arguments: {} }] },
  { content: ["polled"] },
];
const statusCall = (): MockResponse[] => [
  { content: [{ type: "toolCall", name: "freebuff_status", arguments: {} }] },
  { content: ["statused"] },
];
const screenCall = (): MockResponse[] => [
  { content: [{ type: "toolCall", name: "freebuff_screen", arguments: {} }] },
  { content: ["screened"] },
];
const cancelCall = (): MockResponse[] => [
  { content: [{ type: "toolCall", name: "freebuff_cancel", arguments: {} }] },
  { content: ["cancelled"] },
];

interface Rig {
  pluginDir: string;
  configDir: string;
  workspace: string;
  inputLog: string;
}

let savedRunnerJson: string | undefined;
let rig: Rig;

beforeEach(() => {
  resetFreebuffForTests();
  savedRunnerJson = process.env.PI_FREEBUFF_RUNNER_JSON;
  rig = {
    pluginDir: mkdtempSync(join(tmpdir(), "surface-plugin-")),
    configDir: mkdtempSync(join(tmpdir(), "surface-config-")),
    workspace: mkdtempSync(join(tmpdir(), "surface-ws-")),
    inputLog: "",
  };
});

afterEach(async () => {
  // The singleton's dispose drops the runner without killing the child, so the
  // stub pids come from the keystroke log (one spawn line per child).
  if (rig.inputLog !== "") {
    try {
      const pids = new Set(
        eventsOf(readInputLog(rig.inputLog), "spawn")
          .map(entry => entry.pid)
          .filter((pid): pid is number => typeof pid === "number"),
      );
      for (const pid of pids) await killInstance(pid).catch(() => {});
    } catch {
      // No log: no stub ever spawned in this rig.
    }
  }
  resetFreebuffForTests();
  if (savedRunnerJson === undefined) delete process.env.PI_FREEBUFF_RUNNER_JSON;
  else process.env.PI_FREEBUFF_RUNNER_JSON = savedRunnerJson;
  for (const dir of [rig.pluginDir, rig.configDir, rig.workspace]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows cwd lock after the PTY kill; the OS cleans tmp.
    }
  }
});

// Publishes the rig's runner options for the extension to read on first tool
// execute; the stub child is the repo's own runtime with mode knobs in env.
const openRig = (
  mode: string,
  opts: { endDelayMs?: number; ackMs?: number; watchdog?: { deadlineMs?: number; freezeMs?: number } } = {},
): void => {
  rig.inputLog = join(rig.pluginDir, "stub-input.jsonl");
  const env: Record<string, string> = {
    FREEBUFF_STUB_MODE: mode,
    FREEBUFF_STUB_INPUT_LOG: rig.inputLog,
  };
  if (opts.endDelayMs !== undefined) env.FREEBUFF_STUB_END_DELAY_MS = String(opts.endDelayMs);
  process.env.PI_FREEBUFF_RUNNER_JSON = JSON.stringify({
    pluginDir: rig.pluginDir,
    workspace: rig.workspace,
    freebuffConfigDir: rig.configDir,
    command: { application: process.execPath, args: [stubPath] },
    env,
    timings: { ...TIMINGS, ackMs: opts.ackMs ?? TIMINGS.ackMs },
    ...(opts.watchdog === undefined ? {} : { watchdog: opts.watchdog }),
  } satisfies TurnRunnerOptions);
};

// The memoized singleton the tool calls built; the deps factory only matters
// on first creation.
const singleton = (): FreebuffSingleton =>
  getFreebuffSingleton(() => ({ runner: JSON.parse(process.env.PI_FREEBUFF_RUNNER_JSON!) as TurnRunnerOptions }));

// The gate compares session ids only, so a test-side binding carrying the
// session's real id rides the same seam the tool's binding does.
const directBinding = (harness: Harness): OwnerBinding => ({
  sessionId: harness.session.sessionManager.getSessionId(),
  label: "harness",
  hasUI: false,
  paint: () => {},
  push: () => {},
});

const toolResults = (harness: Harness): ToolResultMessage[] =>
  harness.session.sessionManager.getBranch().flatMap(entry =>
    entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
  );

const lastToolResult = (harness: Harness, name: string): ToolResultMessage => {
  const hits = toolResults(harness).filter(message => message.toolName === name);
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1]!;
};

const textOf = (message: ToolResultMessage): string =>
  message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");

// Producer is src/index.ts's push, which sends the SettlePush as details.
const settlePushOf = (entry: { details?: unknown }): SettlePush => entry.details as SettlePush;

const pushMessages = (harness: Harness): { customType: string; content: unknown; details?: unknown }[] =>
  harness.session.sessionManager.getBranch().flatMap(entry =>
    entry.type === "custom_message" && entry.customType === "pi-freebuff" ? [entry] : [],
  );

const waitFor = async (predicate: () => boolean, budgetMs = 15_000): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const tick = (): void => {
    if (predicate() || Date.now() > deadline) resolve();
    else setTimeout(tick, 25);
  };
  const deadline = Date.now() + budgetMs;
  tick();
  await promise;
  if (!predicate()) throw new Error("waitFor: budget exceeded");
};

// A bounded wall-clock hold, for the tests that must NOT observe anything
// before a deadline passes (the watchdog's deadline measures from the Ack).
// Real time on purpose, like waitFor above: the counterpart is a real child
// process behind a real PTY, so no event carries the wait and fake timers
// cannot advance the child's clock.
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// The stub child's pid, straight from the keystroke log's spawn line.
const spawnPid = (path: string): number => {
  const [spawn] = eventsOf(readInputLog(path), "spawn");
  expect(spawn?.pid).toEqual(expect.any(Number));
  return spawn!.pid!;
};

// Polls progress through the singleton until `until` holds, recording every
// phase:phaseSource pair seen on the way (5 ms steps outrun a model turn).
const observePhases = async (
  taskId: string | undefined,
  binding: OwnerBinding,
  until: (details: ProgressDetails) => boolean,
  budgetMs = 20_000,
): Promise<Set<string>> => {
  const seen = new Set<string>();
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const details = singleton().progress(taskId, binding);
      seen.add(`${details.phase}:${details.phaseSource}`);
      if (until(details)) return seen;
    } catch {
      // unknown_task before the submit registers.
    }
    if (Date.now() > deadline) {
      throw new Error(`phase poll budget exceeded; seen: ${[...seen].join(", ") || "nothing"}`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
};

describe("freebuff tool surface over the singleton (harness tier)", () => {
  test(
    "run returns at Ack and the parent continues while the stub turn is in flight",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...progressCall(), ...SPARES],
      });
      try {
        expect(owner.extensionsResult.errors).toEqual([]);
        expect(owner.session.getActiveToolNames()).toEqual(
          expect.arrayContaining(["freebuff_run", "freebuff_progress", "freebuff_cancel", "freebuff_status", "freebuff_screen"]),
        );

        expect(await owner.session.prompt("run it")).toBe(true);
        const run = lastToolResult(owner, "freebuff_run");
        expect(run.isError).toBe(false);
        const runDetails = run.details as SubmitOk;
        expect(runDetails.phase).toBe("working");
        expect(typeof runDetails.taskId).toBe("string");

        expect(await owner.session.prompt("poll")).toBe(true);
        const progress = lastToolResult(owner, "freebuff_progress");
        expect(progress.isError).toBe(false);
        expect(progress.details as ProgressDetails).toMatchObject({ phase: "working", phaseSource: "chat-store" });

        const pid = singleton().instancePid();
        expect(pid).not.toBeNull();
        expect(pidAlive(pid!)).toBe(true);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "second and further submits enqueue at once; the fifth task is refused as busy",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const responses = [
        ...runCall("p1"),
        ...runCall("p2"),
        ...runCall("p3"),
        ...runCall("p4"),
        ...runCall("p5"),
        ...runCall("p6"),
        ...SPARES,
      ];
      const owner = await createHarnessSession({ extensions: [freebuff], responses });
      try {
        expect(await owner.session.prompt("run p1")).toBe(true);
        expect((lastToolResult(owner, "freebuff_run").details as SubmitOk).phase).toBe("working");

        for (let position = 1; position <= 4; position++) {
          expect(await owner.session.prompt(`run p${position + 1}`)).toBe(true);
          const run = lastToolResult(owner, "freebuff_run");
          expect(run.isError).toBe(false);
          expect(run.details as SubmitOk).toMatchObject({ phase: "queued", position });
        }

        expect(await owner.session.prompt("run p6")).toBe(true);
        const busy = lastToolResult(owner, "freebuff_run");
        expect(busy.isError).toBe(true);
        expect(textOf(busy)).toContain("queue is full");
        const busyDetails = busy.details as RejectionDetails;
        expect(busyDetails.busy).toBe(true);
        expect(busyDetails.position).toBe(5);
        expect(busyDetails.code).toBe("busy");
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "the answer arrives once as an aside push and stays pollable verbatim",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...SPARES.slice(1)],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;

        // The session is idle here (the run tool resolved at Ack), so the push
        // starts its own aside turn — never a steer.
        await waitFor(() => pushMessages(owner).length > 0);
        const pushes = pushMessages(owner);
        expect(pushes).toHaveLength(1);
        expect(pushes[0]!.content).toBe(ANSWER);
        expect(settlePushOf(pushes[0]!)).toMatchObject({ ok: true, taskId, answer: ANSWER });

        // Omitted taskId = newest task: the one that just settled. Wait out the
        // push's own aside turn first; a prompt during it is refused as busy.
        await waitFor(() => !owner.session.isStreaming);
        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(false);
        expect(textOf(poll)).toBe(ANSWER);
        const pollDetails = poll.details as ProgressDetails;
        expect(pollDetails.answer).toBe(ANSWER);
        expect(pollDetails.taskId).toBe(taskId);
        expect(pushMessages(owner)).toHaveLength(1);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "phases report their sources: submitting, working, queued, done",
    async () => {
      // slow-ack holds submitting ~1.6 s; END_DELAY holds working after the
      // Ack so the queued submit lands while task one is still active.
      openRig("slow-ack", { endDelayMs: 1200, ackMs: 10_000 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall("p1"), ...runCall("p2"), ...SPARES],
      });
      const binding = directBinding(owner);
      try {
        const first = owner.session.prompt("run p1");
        const seenFirst = await observePhases(undefined, binding, details => details.phase === "working");
        expect(seenFirst.has("submitting:step-state")).toBe(true);
        await first;
        const firstId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;

        expect(await owner.session.prompt("run p2")).toBe(true);
        const second = lastToolResult(owner, "freebuff_run");
        expect(second.details as SubmitOk).toMatchObject({ phase: "queued", position: 1 });
        const secondId = (second.details as SubmitOk).taskId;

        const seenSecond = await observePhases(secondId, binding, details => details.phase === "done");
        expect(seenSecond.has("queued:step-state")).toBe(true);
        expect(seenSecond.has("submitting:step-state")).toBe(true);
        expect(seenSecond.has("working:chat-store")).toBe(true);

        expect(singleton().progress(firstId, binding)).toMatchObject({
          phase: "done",
          phaseSource: "verdict",
        });
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "a failed task settles under its verdict and polls as a tool error",
    async () => {
      openRig("no-answer");
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...SPARES.slice(1)],
      });
      const binding = directBinding(owner);
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        await observePhases(undefined, binding, details => details.phase === "failed");
        // The settle push started its own aside turn; a prompt during it is
        // refused as busy.
        await waitFor(() => !owner.session.isStreaming);

        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        expect(textOf(poll)).toContain("no_answer");
        expect(poll.details as ProgressDetails).toMatchObject({
          phase: "failed",
          phaseSource: "verdict",
          verdict: "no_answer",
        });
        expect(existsSync(join(rig.pluginDir, "tasks", taskId))).toBe(true);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "a second session is refused with the owner named, run and progress alike",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES],
      });
      const bystander = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall("from b"), ...progressCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const ownerSessionId = owner.session.sessionManager.getSessionId();

        expect(await bystander.session.prompt("run from b")).toBe(true);
        const refusedRun = lastToolResult(bystander, "freebuff_run");
        expect(refusedRun.isError).toBe(true);
        expect((refusedRun.details as RejectionDetails).code).toBe("not_owner");
        expect(textOf(refusedRun)).toContain(ownerSessionId);

        expect(await bystander.session.prompt("poll")).toBe(true);
        const refusedProgress = lastToolResult(bystander, "freebuff_progress");
        expect(refusedProgress.isError).toBe(true);
        expect((refusedProgress.details as RejectionDetails).code).toBe("not_owner");
        expect(textOf(refusedProgress)).toContain(ownerSessionId);
      } finally {
        await owner.dispose();
        await bystander.dispose();
      }
    },
    60_000,
  );

  test(
    "state outlives the owning session; a fresh session joins the same singleton",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES],
      });
      const bystander = await createHarnessSession({
        extensions: [freebuff],
        responses: [...statusCall(), ...statusCall(), ...SPARES],
      });
      let reloaded: Harness | null = null;
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        await owner.dispose();

        expect(await bystander.session.prompt("status")).toBe(true);
        const inflight = lastToolResult(bystander, "freebuff_status");
        expect(inflight.isError).toBe(false);
        expect(inflight.details as StatusDetails).toMatchObject({
          queue: { depth: 0 },
          activeTask: { taskId, phase: "working" },
        });

        // The settle pushes into the gone binding, which must swallow it; the
        // archive under tasks/<taskId> proves the settle ran to completion.
        await waitFor(() => existsSync(join(rig.pluginDir, "tasks", taskId)));

        expect(await bystander.session.prompt("status")).toBe(true);
        const settled = lastToolResult(bystander, "freebuff_status");
        const settledDetails = settled.details as StatusDetails;
        expect(settledDetails.activeTask).toBeNull();
        expect(settledDetails.queue.depth).toBe(0);
        expect(settledDetails.archive.count).toBeGreaterThanOrEqual(1);

        reloaded = await createHarnessSession({
          extensions: [freebuff],
          responses: [...runCall("after reload"), ...SPARES],
        });
        expect(await reloaded.session.prompt("run after reload")).toBe(true);
        const fresh = lastToolResult(reloaded, "freebuff_run");
        expect(fresh.isError).toBe(false);
        expect((fresh.details as SubmitOk).phase).toBe("working");
      } finally {
        await bystander.dispose();
        if (reloaded !== null) await reloaded.dispose();
      }
    },
    60_000,
  );

  test(
    "status reads from any session; screen is owner-gated",
    async () => {
      openRig("happy", { endDelayMs: 1500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...screenCall(), ...SPARES],
      });
      const bystander = await createHarnessSession({
        extensions: [freebuff],
        responses: [...statusCall(), ...screenCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;

        expect(await bystander.session.prompt("status")).toBe(true);
        const status = lastToolResult(bystander, "freebuff_status");
        expect(status.isError).toBe(false);
        const details = status.details as StatusDetails;
        expect(details.queue.depth).toBe(0);
        expect(details.activeTask).toMatchObject({ taskId });
        expect(details.lock).toBeDefined();
        expect(details.archive).toBeDefined();
        expect(details.foreign).toBeDefined();

        expect(await bystander.session.prompt("screen")).toBe(true);
        const refused = lastToolResult(bystander, "freebuff_screen");
        expect(refused.isError).toBe(true);
        expect((refused.details as RejectionDetails).code).toBe("not_owner");

        expect(await owner.session.prompt("screen")).toBe(true);
        const screen = lastToolResult(owner, "freebuff_screen");
        expect(screen.isError).toBe(false);
        expect(textOf(screen)).toContain("Add to the current task");
        expect(screen.details as ScreenDetails).toMatchObject({ taskId });
      } finally {
        await owner.dispose();
        await bystander.dispose();
      }
    },
    60_000,
  );

  // -- Watchdog verdicts and failed-result rendering through the tools (#21) ----

  test(
    "a wedged task trips the deadline watchdog: failed progress names deadline, lock gone, stub killed",
    async () => {
      const deadlineMs = 800;
      openRig("wedged", { watchdog: { deadlineMs } });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...SPARES.slice(1)],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const run = lastToolResult(owner, "freebuff_run");
        expect(run.isError).toBe(false);
        const taskId = (run.details as SubmitOk).taskId;

        // Hold past the deadline before the first poll: the watchdog measures
        // from the Ack, so a poll before it can only ever see "working".
        await sleep(deadlineMs + 700);
        await waitFor(() => !owner.session.isStreaming);

        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        const details = poll.details as ProgressDetails;
        expect(details).toMatchObject({
          taskId,
          phase: "failed",
          phaseSource: "verdict",
          verdict: "deadline",
          archivePath: expect.any(String),
          screenExcerpt: expect.any(String),
        });
        expect(details.message).toContain("watchdog failure: deadline");
        // The known error marker the wedged screen raised rides as a warning.
        expect(details.warnings).toEqual([expect.stringContaining("Command not found")]);
        // The failed result carries structured details, not text-encoded JSON:
        // the rendered line is the prose failure line, unparsable as JSON.
        expect(() => JSON.parse(textOf(poll))).toThrow();
        expect(existsSync(join(rig.pluginDir, "lock.json"))).toBe(false);

        await waitFor(() => !pidAlive(spawnPid(rig.inputLog)));
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "a static task trips the freeze watchdog: failed progress names frozen, never reads as success",
    async () => {
      openRig("wedged", { watchdog: { freezeMs: 400 } });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...SPARES.slice(1)],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        await sleep(1_500); // well past freezeMs, far under the default deadline
        await waitFor(() => !owner.session.isStreaming);

        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        const details = poll.details as ProgressDetails;
        expect(details).toMatchObject({ phase: "failed", phaseSource: "verdict", verdict: "frozen" });
        expect(details.message).toContain("watchdog failure: frozen");
        expect(existsSync(join(rig.pluginDir, "lock.json"))).toBe(false);
        await waitFor(() => !pidAlive(spawnPid(rig.inputLog)));
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "a mid-turn crash settles as crashed in the tool result and the stub is gone",
    async () => {
      openRig("kill-mid-turn");
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...SPARES.slice(1)],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        await sleep(1_200); // the stub exits ~100ms after its Ack line
        await waitFor(() => !owner.session.isStreaming);

        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        expect(poll.details as ProgressDetails).toMatchObject({ phase: "failed", verdict: "crashed" });
        expect(existsSync(join(rig.pluginDir, "lock.json"))).toBe(false);
        await waitFor(() => !pidAlive(spawnPid(rig.inputLog)));
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "an unacked submit lands as ack_missing in the run result and the failed progress",
    async () => {
      openRig("no-ack", { ackMs: 600 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        // The submit settles before the Ack, so the push lands mid-turn and
        // never becomes an aside turn: no spare may sit before the poll call.
        responses: [...runCall(PROMPT), ...progressCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        // The submit settles before any Ack, so freebuff_run itself fails and
        // names the verdict in its structured details.
        const run = lastToolResult(owner, "freebuff_run");
        expect(run.isError).toBe(true);
        expect(run.details).toMatchObject({ code: "submit_failed", verdict: "ack_missing" });

        await waitFor(() => !owner.session.isStreaming);
        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        expect(poll.details as ProgressDetails).toMatchObject({
          phase: "failed",
          phaseSource: "verdict",
          verdict: "ack_missing",
          archivePath: expect.any(String),
        });
        expect(existsSync(join(rig.pluginDir, "lock.json"))).toBe(false);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "a no-answer failure leaves the instance live and the next submit reuses it without a respawn",
    async () => {
      openRig("no-answer");
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES.slice(0, 1), ...progressCall(), ...runCall("again"), ...SPARES.slice(1)],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        await waitFor(() => existsSync(join(rig.pluginDir, "tasks", taskId)));
        await waitFor(() => !owner.session.isStreaming);

        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        expect(poll.details as ProgressDetails).toMatchObject({ phase: "failed", phaseSource: "verdict", verdict: "no_answer" });

        // no_answer keeps the Instance: still alive after the failed result,
        // and the second submission reuses it instead of spawning a new stub.
        const pid = spawnPid(rig.inputLog);
        expect(pidAlive(pid)).toBe(true);

        expect(await owner.session.prompt("run again")).toBe(true);
        const second = lastToolResult(owner, "freebuff_run");
        expect(second.isError).toBe(false);
        expect((second.details as SubmitOk).phase).toBe("working");
        expect(eventsOf(readInputLog(rig.inputLog), "spawn")).toHaveLength(1);
        expect(pidAlive(pid)).toBe(true);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  test(
    "the watchdog outlives the owning session's shutdown; the lock frees and the archive names the verdict",
    async () => {
      const deadlineMs = 800;
      openRig("wedged", { watchdog: { deadlineMs } });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES],
      });
      const bystander = await createHarnessSession({
        extensions: [freebuff],
        responses: [...statusCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        // dispose delivers session_shutdown: the singleton keeps the task, the
        // binding's paint/push go silent, and the deadline still settles it.
        await owner.dispose();

        await waitFor(() => existsSync(join(rig.pluginDir, "tasks", taskId)));
        const meta = JSON.parse(readFileSync(join(rig.pluginDir, "tasks", taskId, "meta.json"), "utf8")) as {
          verdict: string;
        };
        expect(meta.verdict).toBe("deadline");

        expect(await bystander.session.prompt("status")).toBe(true);
        const status = lastToolResult(bystander, "freebuff_status");
        expect(status.isError).toBe(false);
        expect(status.details as StatusDetails).toMatchObject({
          lock: { state: "free" },
          queue: { depth: 0 },
          activeTask: null,
        });
      } finally {
        await bystander.dispose();
      }
    },
    60_000,
  );

  test(
    "freebuff_cancel stops the working task; the queued one drains on a fresh instance",
    async () => {
      // A 5 s hold between Ack and end lines: the ladder (~2 s) must beat the
      // stub's natural completion, and the drained task's own 5 s turn fits
      // the budget.
      openRig("happy", { endDelayMs: 5000 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall("p1"), ...runCall("p2"), ...cancelCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run p1")).toBe(true);
        const first = lastToolResult(owner, "freebuff_run");
        const t1 = (first.details as SubmitOk).taskId;
        expect(await owner.session.prompt("run p2")).toBe(true);
        const t2 = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        expect((lastToolResult(owner, "freebuff_run").details as SubmitOk).phase).toBe("queued");

        expect(await owner.session.prompt("cancel p1")).toBe(true);
        const cancel = lastToolResult(owner, "freebuff_cancel");
        expect(cancel.isError).toBe(false);
        expect(cancel.details).toEqual({
          taskId: t1,
          verdict: "cancelled",
          archivePath: join(rig.pluginDir, "tasks", t1),
        });
        expect(textOf(cancel)).toContain(`freebuff task ${t1} cancelled (verdict cancelled)`);
        expect(JSON.parse(readFileSync(join(rig.pluginDir, "tasks", t1, "meta.json"), "utf8"))).toMatchObject({
          verdict: "cancelled",
        });

        // The aside pushes: the cancelled verdict, then the drained task's answer.
        await waitFor(() => pushMessages(owner).length >= 2);
        expect(settlePushOf(pushMessages(owner)[0]!)).toMatchObject({ taskId: t1, ok: false, verdict: "cancelled" });
        expect(settlePushOf(pushMessages(owner)[1]!)).toMatchObject({
          taskId: t2,
          ok: true,
          answer: `stub(DeepSeek V4.1 Flash): p2`,
        });

        // The ladder ran to its last rung and the drained task spawned fresh.
        const events = readInputLog(rig.inputLog);
        expect(eventsOf(events, "esc")).toHaveLength(1);
        expect(eventsOf(events, "ctrl-c")).toHaveLength(3);
        expect(eventsOf(events, "spawn")).toHaveLength(2);
        await waitFor(() => !owner.session.isStreaming);
      } finally {
        await owner.dispose();
      }
    },
    90_000,
  );

  test(
    "a disposed owner detaches the working task: it completes with its real answer, silently",
    async () => {
      openRig("happy", { endDelayMs: 500 });
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES],
      });
      const bystander = await createHarnessSession({
        extensions: [freebuff],
        responses: [...statusCall(), ...statusCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const taskId = (lastToolResult(owner, "freebuff_run").details as SubmitOk).taskId;
        // dispose delivers session_shutdown: the Detached Task keeps its
        // Watchdog and Lock, and the settle push into the gone binding is a
        // silent no-op.
        await owner.dispose();

        await waitFor(() => existsSync(join(rig.pluginDir, "tasks", taskId)));
        // The REAL verdict, not a cancel: the stub completed its turn.
        expect(readFileSync(join(rig.pluginDir, "tasks", taskId, "answer.md"), "utf8")).toBe(ANSWER);
        const meta = JSON.parse(readFileSync(join(rig.pluginDir, "tasks", taskId, "meta.json"), "utf8")) as {
          verdict: string | null;
          phaseLog: string[];
        };
        expect(meta.verdict).toBeNull();
        expect(meta.phaseLog.at(-1)).toContain("done@");

        expect(await bystander.session.prompt("status")).toBe(true);
        const status = lastToolResult(bystander, "freebuff_status");
        expect(status.isError).toBe(false);
        expect((status.details as StatusDetails).activeTask).toBeNull();
        expect((status.details as StatusDetails).lock.state).toBe("free");
      } finally {
        await bystander.dispose();
      }
    },
    60_000,
  );

  test(
    "a cancel while the run call is parked before the Ack errors the parked call and kills the instance",
    async () => {
      openRig("no-ack");
      const owner = await createHarnessSession({
        extensions: [freebuff],
        responses: [...runCall(PROMPT), ...SPARES],
      });
      const binding = directBinding(owner);
      try {
        const first = owner.session.prompt("run it");
        await waitFor(() => existsSync(rig.inputLog) && kindsOf(readInputLog(rig.inputLog)).includes("submit"));

        // The same public seam the tool uses: the session is mid-turn, so the
        // cancel cannot ride a prompt of its own.
        expect(await singleton().cancel(binding)).toMatchObject({ verdict: "cancelled" });
        expect(await first).toBe(true);
        const run = lastToolResult(owner, "freebuff_run");
        expect(run.isError).toBe(true);
        expect(run.details).toMatchObject({ code: "submit_failed", verdict: "cancelled" });

        // The ladder ran to the forced kill: the stub is gone.
        const events = readInputLog(rig.inputLog);
        expect(eventsOf(events, "esc")).toHaveLength(1);
        expect(eventsOf(events, "ctrl-c")).toHaveLength(3);
        await waitFor(() => !pidAlive(spawnPid(rig.inputLog)));
        expect(existsSync(join(rig.pluginDir, "lock.json"))).toBe(false);
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );

  // The stub's own failure frames: the settle loop reads each frame and fails
  // with zero keystrokes, and both tool surfaces name the mapped verdict.
  test.each([
    ["takeover", "slot_held"],
    ["displaced", "displaced"],
    ["unknown", "driver_error"],
  ] as const)(
    "a %s frame fails the submit with verdict %s, named in run and progress alike",
    async (mode, verdict) => {
      openRig(mode);
      const owner = await createHarnessSession({
        extensions: [freebuff],
        // The submit settles before the Ack, so the push lands mid-turn and
        // never becomes an aside turn: no spare may sit before the poll call.
        responses: [...runCall(PROMPT), ...progressCall(), ...SPARES],
      });
      try {
        expect(await owner.session.prompt("run it")).toBe(true);
        const run = lastToolResult(owner, "freebuff_run");
        expect(run.isError).toBe(true);
        expect(run.details).toMatchObject({ code: "submit_failed", verdict });

        await waitFor(() => !owner.session.isStreaming);
        expect(await owner.session.prompt("poll")).toBe(true);
        const poll = lastToolResult(owner, "freebuff_progress");
        expect(poll.isError).toBe(true);
        expect(poll.details as ProgressDetails).toMatchObject({
          phase: "failed",
          phaseSource: "verdict",
          verdict,
          archivePath: expect.any(String),
          screenExcerpt: expect.any(String),
        });
        // The settle failed before any keystroke: nothing but the spawn logged.
        expect(kindsOf(readInputLog(rig.inputLog))).toEqual(["spawn"]);
        await waitFor(() => !pidAlive(spawnPid(rig.inputLog)));
      } finally {
        await owner.dispose();
      }
    },
    60_000,
  );
});
