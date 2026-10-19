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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { eventsOf, readInputLog } from "./helpers/stubInputLog";

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
const openRig = (mode: string, opts: { endDelayMs?: number; ackMs?: number } = {}): void => {
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
});
