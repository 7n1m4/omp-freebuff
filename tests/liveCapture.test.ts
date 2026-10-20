// The gated capture run (PI_FREEBUFF_CAPTURE): one real Task whose live screen
// is sampled throughout submit -> settle, every unique frame written under the
// real config dir's screen-dumps/<version>/ via the production dump scheme, then
// replayed through the host vterm to prove each dump re-classifies. The console
// table is the promotion-ready record: dump file -> identity/level.
//
// Unlike the live tier this module MUST run against a drifted version too —
// it is the re-measure path — so it gates only on readable metadata, never on
// MEASURED_FREEBUFF_VERSION. Never run it casually: it consumes one real
// Hour-session task and writes into the real config dir.
import { basename, join } from "node:path";
import { expect, test } from "bun:test";
import { classifyScreen, freezeKey } from "../src/protocol/screen";
import { metadataVersion, writeScreenDump } from "../src/protocol/screenDump";
import type { ProgressDetails, SettlePush } from "../src/singleton";
import { defaultFreebuffConfigDir } from "../src/status";
import {
  buildLiveRig,
  CAPTURE_TEST_FLAG,
  liveBinding,
  liveEnabled,
  sleepMs,
  teardownLiveRig,
} from "./helpers/live";
import { replayAnsiFile } from "./helpers/replay";

const CAPTURE_TIMEOUT = 12 * 60_000;
const SETTLE_BUDGET_MS = 6 * 60_000;
const SAMPLE_MS = 500;
const POLL_MS = 1_000;
const LIVE_PROMPT = "Reply with exactly: OK";

const captureTest = test.skipIf(!liveEnabled(CAPTURE_TEST_FLAG));

captureTest("capture samples one real Task's screens into promotion-ready dumps", async () => {
  const configDir = defaultFreebuffConfigDir();
  const version = metadataVersion(configDir);
  if (version === null) {
    throw new Error(`no readable freebuff-metadata.json under ${configDir}; refusing to capture without a version folder`);
  }
  const rig = buildLiveRig();
  const pushes: SettlePush[] = [];
  const binding = liveBinding(pushes);
  // freezeKey -> dump path: the dedup matches writeScreenDump's own one-file-per-key rule.
  const dumps = new Map<string, string>();
  let instancePid: number | null = null;

  const sample = async (): Promise<void> => {
    let text: string;
    try {
      text = await rig.singleton.screenText(binding);
    } catch {
      return; // no live Instance yet (before the spawn) or just gone (after the kill)
    }
    const key = freezeKey(text);
    if (dumps.has(key)) return;
    const read = classifyScreen(text);
    // A pass-level frame must not masquerade as unrecognized- (the drift alarm
    // counts that prefix) or degraded-; only genuinely unclassified frames do.
    const kind = read.level === "fail" || read.identity === null ? "unrecognized" : read.level === "degraded" ? "degraded" : "capture";
    const path = writeScreenDump(configDir, text, kind);
    if (path !== null) dumps.set(key, path);
  };

  try {
    const ack = await rig.singleton.submit({ prompt: LIVE_PROMPT, cwd: rig.target, binding });
    console.log(`[capture] ack: ${JSON.stringify(ack)}; sampling every ${SAMPLE_MS}ms`);
    expect(ack.phase).toBe("working");

    let progress: ProgressDetails | undefined;
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    while (Date.now() < deadline) {
      progress = rig.singleton.progress(ack.taskId, binding);
      await sample();
      if (progress.phase === "done" || progress.phase === "failed") break;
      await sleepMs(POLL_MS);
    }
    await sample(); // the settled screen
    if (progress === undefined) throw new Error("the settle poll never ran");
    if (progress.phase !== "done") {
      throw new Error(`task ${ack.taskId} settled ${progress.phase}${progress.message ? `: ${progress.message}` : ""}`);
    }
    expect(progress.answer?.length ?? 0).toBeGreaterThan(0);
    expect(dumps.size).toBeGreaterThan(0);

    const rows: string[] = [];
    for (const path of [...dumps.values()].sort()) {
      const read = classifyScreen(await replayAnsiFile(path));
      rows.push(`${basename(path)}\t${read.identity ?? "null"}\t${read.level}`);
    }
    console.log(`[capture] version ${version}: ${dumps.size} unique frames under ${join(configDir, "screen-dumps", version)}`);
    console.log(`dump file\tidentity\tlevel\n${rows.join("\n")}`);
    console.log(`[capture] promote: copy a dump into tests/fixtures/screen/${version}/ keeping the hash name, add its RECORDED row, run bun test tests/corpus.test.ts`);

    instancePid = rig.singleton.instancePid();
    console.log(`[capture] recorded instance pid for teardown: ${instancePid}`);
  } finally {
    await teardownLiveRig(rig, instancePid);
  }
}, CAPTURE_TIMEOUT);
