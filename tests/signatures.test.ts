import { describe, expect, test } from "bun:test";
import { recognizeScreen } from "../src/protocol/signatures";
import { replayFixture } from "./helpers/replay";

// Hand-built 0.2.29-shaped frames. The composer box is the real 160-col bordered
// input block; every frame leaves the usage row (or its absence) in the region the
// signatures actually read.
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
const usageRow = statusRow("34m left · 15.2K (1%)");

const readyFrame = [transcript, usageRow, readyComposer].join("\n");
// The composer plus no usage row: something displaced the session screen.
const displacedFrame = [transcript, readyComposer].join("\n");
// Countdown text gone, the `✕ End session` tail kept: ready must degrade, not displace.
const degradedFrame = [transcript, statusRow("15.2K (1%)"), readyComposer].join("\n");
const workingFrame = [
  transcript,
  " ⎘ • 1m 30s • ■▽",
  usageRow,
  composer("Add to the current task (/ for commands)"),
].join("\n");
const draftFrame = [transcript, statusRow("Chat: New chat · 34m left · 15.2K (1%)"), readyComposer].join("\n");
// The footer chat segment without a usage row: displaced outranks draft.
const draftBaitFrame = [transcript, " Chat: New chat", readyComposer].join("\n");

const welcomeBox = [
  "╭" + "─".repeat(62) + "╮",
  "│" + " Your first message starts the session".padEnd(62) + "│",
  "╰" + "─".repeat(62) + "╯",
].join("\n");
const welcomeFrame = [welcomeBox, "", readyComposer].join("\n");

// The 0.2.29 take-over prompt renders the welcome box behind it, so the dialog
// wording must win over WELCOME_BOX.
const takeoverDialog = [
  "╭" + "─".repeat(70) + "╮",
  "│" + " Session already running in another window.".padEnd(70) + "│",
  "│" + "".padEnd(70) + "│",
  "│" + " ↵ Enter: take over".padEnd(70) + "│",
  "│" + "   Take over to attach this window to the Hour session".padEnd(70) + "│",
  "╰" + "─".repeat(70) + "╯",
].join("\n");
const takeoverFrame = [welcomeBox, "", takeoverDialog].join("\n");

const costModal = [
  "╭" + "─".repeat(60) + "╮",
  "│" + " First submit of this session".padEnd(60) + "│",
  "│" + "".padEnd(60) + "│",
  "│" + " ↵ confirm and send".padEnd(60) + "│",
  "│" + " Esc back to draft".padEnd(60) + "│",
  "╰" + "─".repeat(60) + "╯",
].join("\n");
const costModalFrame = [transcript, costModal].join("\n");

const continueFrame = [transcript, "Press Enter to continue"].join("\n");

describe("recognizeScreen", () => {
  test("ready is the composer frame with the usage row, at pass", () => {
    expect(recognizeScreen(readyFrame)).toEqual({ screen: "ready", level: "pass", missing: [] });
  });

  test("the take-over dialog outranks the welcome box it renders behind", () => {
    expect(recognizeScreen(takeoverFrame).screen).toBe("Session-in-use dialog");
    expect(recognizeScreen(takeoverFrame).level).toBe("pass");
  });

  test("the welcome frame is the Welcome screen, never displaced or draft", () => {
    expect(recognizeScreen(welcomeFrame)).toEqual({ screen: "Welcome screen", level: "pass", missing: [] });
  });

  test("displaced is the composer layout without the usage row", () => {
    expect(recognizeScreen(displacedFrame)).toEqual({ screen: "displaced", level: "pass", missing: [] });
  });

  test("ready keeps its usage row: displaced never eats it", () => {
    expect(recognizeScreen(readyFrame).screen).not.toBe("displaced");
  });

  test("ready without the countdown wording degrades, naming COUNTDOWN_REGEX", () => {
    expect(recognizeScreen(degradedFrame)).toEqual({
      screen: "ready",
      level: "degraded",
      missing: ["COUNTDOWN_REGEX"],
    });
  });

  test("draft is the footer chat segment without a welcome box", () => {
    expect(recognizeScreen(draftFrame)).toEqual({ screen: "draft", level: "pass", missing: [] });
  });

  test("the chat segment without the usage row is displaced, not draft", () => {
    expect(recognizeScreen(draftBaitFrame).screen).toBe("displaced");
  });

  test("working is the re-labeled composer placeholder", () => {
    expect(recognizeScreen(workingFrame)).toEqual({ screen: "working", level: "pass", missing: [] });
  });

  test("the cost modal outranks the screens beneath it", () => {
    expect(recognizeScreen(costModalFrame)).toEqual({ screen: "cost modal", level: "pass", missing: [] });
  });

  test("Continue is its prompt wording", () => {
    expect(recognizeScreen(continueFrame)).toEqual({ screen: "Continue", level: "pass", missing: [] });
  });

  test("a blank frame is a known paint transition, not a screen", () => {
    expect(recognizeScreen("   \n  \n")).toEqual({ screen: "blank", level: "pass", missing: [] });
  });

  test("connecting stays connecting with the prompt rendered below", async () => {
    expect(recognizeScreen(await replayFixture("synthetic/connecting")).screen).toBe("connecting");
  });

  test("connecting-to-ready is ready once the rewrite erases Connecting", async () => {
    expect(recognizeScreen(await replayFixture("synthetic/connecting-to-ready")).screen).toBe("ready");
  });

  test("repaint keeps the last frame as ready", async () => {
    expect(recognizeScreen(await replayFixture("synthetic/repaint")).screen).toBe("ready");
  });

  test("login-required is the login gate", async () => {
    expect(recognizeScreen(await replayFixture("synthetic/login-required")).screen).toBe("login gate");
  });

  test("ad-panel matches no known screen", async () => {
    expect(recognizeScreen(await replayFixture("negative/ad-panel"))).toEqual({ screen: null, level: "fail", missing: [] });
  });

  test("generic-words matches no known screen", async () => {
    expect(recognizeScreen(await replayFixture("negative/generic-words"))).toEqual({
      screen: null,
      level: "fail",
      missing: [],
    });
  });

  test("mid-turn-esc: the retired ticker wording is never working, ready or displaced", async () => {
    expect(recognizeScreen(await replayFixture("negative/mid-turn-esc"))).toEqual({
      screen: null,
      level: "fail",
      missing: [],
    });
  });

  test("continue-wording-answer is ready at pass, never Continue", async () => {
    expect(recognizeScreen(await replayFixture("synthetic/continue-wording-answer"))).toEqual({
      screen: "ready",
      level: "pass",
      missing: [],
    });
  });
});
