import { describe, expect, test } from "bun:test";
import { classifyScreen, freezeKey } from "../src/protocol/screen";
import { DEFAULT_PRESS_THROTTLE_MS, awaitSettled } from "../src/settle";
import type { SettleIo } from "../src/settle";
import { replayFixture } from "./helpers/replay";

// Hand-built 0.2.29-shaped frames, framed like tests/signatures.test.ts; the
// precondition block keeps them honest against the signature table, so a marker
// change fails here, not live.
const boxSide = (content: string): string => "│" + content.padEnd(158) + "│";
const composer = (placeholder: string): string =>
  [
    "╭" + "─".repeat(158) + "╮",
    boxSide(""),
    boxSide("  ▍" + placeholder),
    boxSide(""),
    "╰" + "─".repeat(158) + "╯",
  ].join("\n");
const statusRow = (left: string): string => (" " + left).padEnd(160 - "✕ End session".length) + "✕ End session";

const transcript = [
  "Directory C:\\work\\demo-app",
  "",
  "  [10:00 AM]",
  "  List three colors ⎘",
  "",
  "  • Thinking",
  "  red, green, blue ⎘",
].join("\n");
const readyComposer = composer("Enter a coding task or / for commands");

const continueFrame = [transcript, "Press Enter to continue"].join("\n");
const costModal = [
  "╭" + "─".repeat(60) + "╮",
  "│" + " First submit of this session".padEnd(60) + "│",
  "│" + "".padEnd(60) + "│",
  "│" + " ↵ confirm and send".padEnd(60) + "│",
  "│" + " Esc back to draft".padEnd(60) + "│",
  "╰" + "─".repeat(60) + "╯",
].join("\n");
const costModalFrame = [transcript, costModal].join("\n");
const loginFrame = [transcript, "Not authenticated"].join("\n");
const connectingFrame = [transcript, "Connecting..."].join("\n");
const degradedFrame = [transcript, statusRow("15.2K (1%)"), readyComposer].join("\n");
const unnamedFrame = ["totally unknown frame", "nothing recognized here"].join("\n");
const unnamedAltFrame = ["another unrecognized frame", "still nothing known here"].join("\n");

const fixture = (name: string): Promise<string> => replayFixture(`0.2.29/${name}`);

// Frames advance as the clock runs (each sleep serves the next frame, the last one
// held); press() only records, so the frames under test never move on a keystroke.
const scriptIo = (frames: string[]) => {
  let now = 0;
  let step = 0;
  const presses: { key: string; at: number }[] = [];
  const dumps: { text: string; kind: "unrecognized" | "degraded"; at: number }[] = [];
  const io: SettleIo = {
    read: async () => frames[Math.min(step, frames.length - 1)],
    press: async (key) => {
      presses.push({ key, at: now });
    },
    sleep: async (ms) => {
      now += ms;
      step++;
    },
    now: () => now,
    dump: (text, kind) => {
      dumps.push({ text, kind, at: now });
    },
  };
  return { io, presses, dumps };
};

const POLL_MS = 250;
// Enough held frames to carry a solicited screen past the throttle window before the
// final frame: the Enter may only fire once the spacing elapses.
const THROTTLE_FRAMES = (throttleMs: number): number => Math.ceil(throttleMs / POLL_MS) + 1;

describe("frame preconditions against the signature table", () => {
  test("hand-built frames recognize as intended", () => {
    expect(classifyScreen(continueFrame)).toMatchObject({ identity: "Continue", level: "pass" });
    expect(classifyScreen(costModalFrame)).toMatchObject({ identity: "cost modal", level: "pass" });
    expect(classifyScreen(loginFrame)).toMatchObject({ identity: "login gate", level: "pass" });
    expect(classifyScreen(connectingFrame)).toMatchObject({ identity: "connecting", level: "pass" });
    expect(classifyScreen(degradedFrame)).toMatchObject({ identity: "ready", level: "degraded", missing: ["COUNTDOWN_REGEX"] });
    expect(classifyScreen(unnamedFrame)).toMatchObject({ identity: null, level: "fail" });
    expect(classifyScreen(unnamedAltFrame)).toMatchObject({ identity: null, level: "fail" });
  });

  test("0.2.29 fixtures recognize as intended", async () => {
    expect(classifyScreen(await fixture("ready"))).toMatchObject({ identity: "ready", level: "pass" });
    expect(classifyScreen(await fixture("welcome"))).toMatchObject({ identity: "Welcome screen", level: "pass" });
    expect(classifyScreen(await fixture("take-over-prompt"))).toMatchObject({ identity: "Session-in-use dialog", level: "pass" });
    expect(classifyScreen(await fixture("displaced"))).toMatchObject({ identity: "displaced", level: "pass" });
    expect(classifyScreen(await fixture("working"))).toMatchObject({ identity: "working", level: "pass" });
    expect(classifyScreen(await fixture("queued-composer"))).toMatchObject({ identity: "draft", level: "pass" });
  });
});

describe("awaitSettled", () => {
  test("settles ready on the ready screen", async () => {
    const { io, presses, dumps } = scriptIo([await fixture("ready")]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({ ok: true, state: "ready" });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("settles idle on the Welcome screen", async () => {
    const { io, presses, dumps } = scriptIo([await fixture("welcome")]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({ ok: true, state: "idle" });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("a held Continue screen earns exactly one throttled Enter", async () => {
    const { io, presses, dumps } = scriptIo([continueFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([{ key: "\r", at: DEFAULT_PRESS_THROTTLE_MS }]);
    expect(dumps).toEqual([]);
  });

  test("a Continue screen settles ready after its single Enter", async () => {
    const frames = [...Array(THROTTLE_FRAMES(DEFAULT_PRESS_THROTTLE_MS)).fill(continueFrame), await fixture("ready")];
    const { io, presses } = scriptIo(frames);
    await expect(awaitSettled(io, { readyMs: 30_000, pollMs: POLL_MS })).resolves.toEqual({ ok: true, state: "ready" });
    expect(presses).toEqual([{ key: "\r", at: DEFAULT_PRESS_THROTTLE_MS }]);
  });

  test("a custom pressThrottleMs spaces the Enter accordingly", async () => {
    const frames = [...Array(THROTTLE_FRAMES(1_000)).fill(continueFrame), await fixture("ready")];
    const { io, presses } = scriptIo(frames);
    await expect(
      awaitSettled(io, { readyMs: 30_000, pollMs: POLL_MS, pressThrottleMs: 1_000 }),
    ).resolves.toEqual({ ok: true, state: "ready" });
    expect(presses).toEqual([{ key: "\r", at: 1_000 }]);
  });

  test("a held cost modal earns exactly one throttled Enter", async () => {
    const { io, presses, dumps } = scriptIo([costModalFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([{ key: "\r", at: DEFAULT_PRESS_THROTTLE_MS }]);
    expect(dumps).toEqual([]);
  });

  test("the modal Enter waits out the throttle spacing after the Continue Enter", async () => {
    const frames = [
      ...Array(THROTTLE_FRAMES(DEFAULT_PRESS_THROTTLE_MS)).fill(continueFrame),
      ...Array(THROTTLE_FRAMES(DEFAULT_PRESS_THROTTLE_MS)).fill(costModalFrame),
    ];
    const { io, presses } = scriptIo(frames);
    await expect(awaitSettled(io, { readyMs: 30_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(presses).toHaveLength(2);
    expect(presses.every((p) => p.key === "\r")).toBe(true);
    expect(presses[1].at - presses[0].at).toBeGreaterThanOrEqual(DEFAULT_PRESS_THROTTLE_MS);
  });

  test("the take-over dialog fails slot_held with zero keystrokes", async () => {
    const { io, presses, dumps } = scriptIo([await fixture("take-over-prompt")]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "slot_held",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("a displaced screen fails displaced with zero keystrokes", async () => {
    const { io, presses, dumps } = scriptIo([await fixture("displaced")]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "displaced",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("the login gate fails needs_login immediately", async () => {
    const { io, presses, dumps } = scriptIo([loginFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "needs_login",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("working and draft frames keep polling without a keystroke", async () => {
    for (const frame of [await fixture("working"), await fixture("queued-composer")]) {
      const { io, presses, dumps } = scriptIo([frame]);
      await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
        ok: false,
        reason: "ready_timeout",
        excerpt: expect.any(String),
      });
      expect(presses).toEqual([]);
      expect(dumps).toEqual([]);
    }
  });

  test("a connecting frame keeps polling without a keystroke", async () => {
    const { io, presses, dumps } = scriptIo([connectingFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  test("an unnamed frame burns the deadline, dumps unrecognized once, presses nothing", async () => {
    const { io, presses, dumps } = scriptIo([unnamedFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(dumps).toEqual([{ text: unnamedFrame, kind: "unrecognized", at: 0 }]);
    expect(presses).toEqual([]);
  });

  test("unnamed frames dump once per freeze key", async () => {
    const { io, dumps } = scriptIo([unnamedFrame, unnamedAltFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(dumps.map((d) => d.kind)).toEqual(["unrecognized", "unrecognized"]);
    const keys = new Set(dumps.map((d) => freezeKey(d.text)));
    expect(keys.size).toBe(2);
  });

  test("a degraded frame dumps degraded and keeps polling", async () => {
    const { io, presses, dumps } = scriptIo([degradedFrame]);
    await expect(awaitSettled(io, { readyMs: 9_000, pollMs: POLL_MS })).resolves.toEqual({
      ok: false,
      reason: "ready_timeout",
      excerpt: expect.any(String),
    });
    expect(dumps).toEqual([{ text: degradedFrame, kind: "degraded", at: 0 }]);
    expect(presses).toEqual([]);
  });
});
