// Ticket #27 slice 2, the gated live tier: the port drives the REAL installed
// freebuff CLI end to end, one test per acceptance criterion. Runs only under
// PI_FREEBUFF_LIVE=1 and consumes one real Hour-session task, so it is run
// deliberately, never in CI. No hooks: a skipped module must not run anything,
// so every test builds and tears down its own rig inline.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { releaseLock } from "../src/lock";
import { MEASURED_FREEBUFF_VERSION, measuredVersionReport } from "../src/protocol/recorded";
import { metadataVersion } from "../src/protocol/screenDump";
import type { ProgressDetails, SettlePush } from "../src/singleton";
import { defaultFreebuffConfigDir } from "../src/status";
import {
  assertMeasuredVersion,
  buildLiveRig,
  LIVE_TEST_FLAG,
  liveBinding,
  liveEnabled,
  plantKeeperLock,
  sleepMs,
  teardownLiveRig,
  type LiveRig,
} from "./helpers/live";

const VERSION_TIMEOUT = 30_000;
const REFUSAL_TIMEOUT = 60_000;
const E2E_TIMEOUT = 10 * 60_000;
const SETTLE_BUDGET_MS = 6 * 60_000;
const POLL_MS = 1_000;
const LIVE_PROMPT = "Reply with exactly: OK";

const liveTest = test.skipIf(!liveEnabled(LIVE_TEST_FLAG));

// AC 1: the installed CLI is exactly the version the screen wordings were
// measured against. Pure metadata read; nothing spawns.
liveTest(`installed freebuff matches the measured ${MEASURED_FREEBUFF_VERSION}`, () => {
  const installed = metadataVersion(defaultFreebuffConfigDir());
  const report = measuredVersionReport(installed);
  if (!report.ok) throw new Error(report.message);
  expect(installed).toBe(MEASURED_FREEBUFF_VERSION);
}, VERSION_TIMEOUT);

// AC 3: Lock obedience. A live foreign keeper record holds the rig's plugin
// dir; the submit must wait out its (shortened) claim deadline and refuse
// naming the holder pid, leaving the record byte-identical and nothing spawned.
liveTest("a held Lock refuses the submit naming the holder, and nothing spawns", async () => {
  const rig = buildLiveRig({ lockDeadlineMs: 1_500 });
  const sleeper = await plantKeeperLock(rig.pluginDir);
  console.log(`[live] refusal: sleeper pid ${sleeper.pid}, planted record ${JSON.stringify(sleeper.record)}`);
  const lockBefore = readFileSync(join(rig.pluginDir, "lock.json"), "utf8");
  try {
    let rejection: { code?: string; message?: string } | undefined;
    try {
      await rig.singleton.submit({ prompt: LIVE_PROMPT, cwd: rig.target, binding: liveBinding([]) });
      rejection = undefined;
    } catch (error) {
      rejection = error as { code?: string; message?: string };
    }
    console.log(`[live] refusal message: ${rejection?.message}`);
    expect(rejection?.code).toBe("lock_busy");
    expect(rejection?.message ?? "").toContain(`held by pid ${sleeper.pid}`);
    expect(readFileSync(join(rig.pluginDir, "lock.json"), "utf8")).toBe(lockBefore);
    expect(rig.singleton.instancePid()).toBeNull();
    expect(existsSync(join(rig.pluginDir, "tasks"))).toBe(false);
    expect(readdirSync(rig.workspace)).toEqual(["repo"]); // the junction only: the runner never worked there
  } finally {
    // The record is ours-by-construction (a temp rig); the sleeper pid is not,
    // so the helper's lock-gone assert needs it removed here.
    sleeper.kill();
    releaseLock(rig.pluginDir);
    await teardownLiveRig(rig, null);
  }
}, REFUSAL_TIMEOUT);

// AC 2 + 6: one real Task through the singleton. Submit returns at the Ack,
// the settle push carries the same answer a poll returns, the archive holds
// the settle facts, and teardown leaves neither Lock nor live Instance.
liveTest("one real Task: submit at Ack, settle push matches the poll answer, no orphan Instance", async () => {
  assertMeasuredVersion(); // fail fast before any spawn on version drift
  const rig: LiveRig = buildLiveRig();
  const pushes: SettlePush[] = [];
  const binding = liveBinding(pushes);
  let instancePid: number | null = null;
  try {
    const ack = await rig.singleton.submit({ prompt: LIVE_PROMPT, cwd: rig.target, binding });
    console.log(`[live] ack: ${JSON.stringify(ack)}`);
    expect(ack.phase).toBe("working");
    const { taskId } = ack;

    const phases: string[] = [];
    const seen = new Set<string>(["queued", "submitting"]); // phases passed through before the first poll lands
    let progress: ProgressDetails | undefined;
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    while (Date.now() < deadline) {
      progress = rig.singleton.progress(taskId, binding);
      if (!seen.has(progress.phase)) {
        seen.add(progress.phase);
        phases.push(progress.phase);
        console.log(`[live] ${taskId}: phase ${progress.phase} (${progress.phaseSource}) at ${progress.elapsedMs}ms`);
      }
      if (progress.phase === "done" || progress.phase === "failed") break;
      await sleepMs(POLL_MS);
    }
    if (progress === undefined) throw new Error("the settle poll never ran");
    console.log(`[live] phases: ${["submitting", ...phases].join(" -> ")}`);
    if (progress.phase !== "done") {
      throw new Error(`task ${taskId} settled ${progress.phase}${progress.message ? `: ${progress.message}` : ""}`);
    }

    // The push is the delivery channel; the poll is the recovery. Same text.
    expect(pushes.length).toBe(1);
    expect(pushes[0]?.ok).toBe(true);
    expect(typeof progress.answer).toBe("string");
    expect(progress.answer?.length ?? 0).toBeGreaterThan(0);
    expect(pushes[0]?.answer).toBe(progress.answer);
    console.log(`[live] verdict done, answer preview: ${JSON.stringify(progress.answer?.slice(0, 200))}`);

    const archive = join(rig.pluginDir, "tasks", taskId);
    for (const file of ["meta.json", "answer.md", "chat-messages.json", "screen.txt"]) {
      expect(existsSync(join(archive, file))).toBe(true);
    }
    const meta = JSON.parse(readFileSync(join(archive, "meta.json"), "utf8")) as {
      id: string;
      verdict: string | null;
      phaseLog: string[];
      instancePid: number | null;
    };
    expect(meta.id).toBe(taskId);
    // Success archives no Verdict field; the done@ tombstone is the terminal marker.
    const terminal = meta.phaseLog.at(-1) ?? "";
    expect(terminal.startsWith("done@")).toBe(true);
    console.log(
      `[live] archive: verdict ${JSON.stringify(meta.verdict)} (null on success), terminal phase "${terminal}", instancePid ${meta.instancePid}`,
    );

    instancePid = rig.singleton.instancePid();
    console.log(`[live] recorded instance pid for teardown: ${instancePid}`);
  } finally {
    await teardownLiveRig(rig, instancePid);
  }
}, E2E_TIMEOUT);
