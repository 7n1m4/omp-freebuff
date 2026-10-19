import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { COUNTDOWN_REGEX, KNOWN_ERROR_STRINGS } from "../src/protocol/markers";
import {
  CliTerminalScreen,
  classifyScreen,
  errorLines,
  flattenScreen,
  freezeKey,
  screenExcerpt,
} from "../src/protocol/screen";
import { replayFixture } from "./helpers/replay";

const dir = new URL("./fixtures/screen/", import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), "utf8");

describe("flattenScreen", () => {
  test("renders chunks through one shared screen", async () => {
    expect((await replayFixture("synthetic/repaint")).split("\n")).toHaveLength(48);
  });

  test("reassembles an escape sequence split mid-sequence", async () => {
    const raw = load("synthetic/split-escape.ansi");
    const cut = raw.indexOf("\x1b[2J") + "\x1b[2".length;
    // Replay both halves as the PTY would emit them (\r\n), split at the escape.
    const flat = await flattenScreen(
      [raw.slice(0, cut), raw.slice(cut)].map((chunk) => chunk.replace(/\n/g, "\r\n")),
    );
    expect(classifyScreen(flat).identity).toBe("ready");
    expect(flat).toBe(await flattenScreen([raw.replace(/\n/g, "\r\n")]));
  });

  test("completes a partial line across writes", async () => {
    const raw = load("synthetic/partial-line.ansi");
    const cut = raw.indexOf("Connecting") + "Connect".length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain("Connecting...");
    expect(classifyScreen(flat).identity).toBe("connecting");
  });

  test("keeps the last repaint", async () => {
    const flat = await replayFixture("synthetic/repaint");
    expect(flat).not.toContain("Connecting");
    expect(classifyScreen(flat).identity).toBe("ready");
  });

  test("reads the viewport, not scrollback, once output exceeds the screen", async () => {
    const screen = new CliTerminalScreen();
    for (let i = 0; i < 60; i++) screen.write(`line-${i}\r\n`);
    await screen.flush();
    const text = screen.text();
    expect(text).toContain("line-59");
    expect(text).toContain("line-13\n");
    expect(text).not.toContain("line-12\n");
    expect(text).not.toContain("line-0\n");
  });
});

describe("classifyScreen", () => {
  test("returns exactly the six ScreenRead fields on a ready frame", async () => {
    const flat = await replayFixture("synthetic/continue-wording-answer");
    expect(classifyScreen(flat)).toEqual({
      identity: "ready",
      level: "pass",
      missing: [],
      settled: true,
      reuseReady: true,
      drift: false,
    });
  });

  test("a blank frame is known but no screen: not settled, not drift", () => {
    expect(classifyScreen("\n  \n")).toEqual({
      identity: "blank",
      level: "pass",
      missing: [],
      settled: false,
      reuseReady: false,
      drift: false,
    });
  });

  test("an unrecognized frame arms drift", async () => {
    expect(classifyScreen(await replayFixture("negative/generic-words"))).toEqual({
      identity: null,
      level: "fail",
      missing: [],
      settled: false,
      reuseReady: false,
      drift: true,
    });
  });

  test("a degraded ready frame names its missing marker and never arms drift", async () => {
    const flat = await replayFixture("synthetic/continue-wording-answer");
    const drifted = flat.replace("58m left · ", "");
    expect(COUNTDOWN_REGEX.test(drifted)).toBe(false);
    expect(classifyScreen(drifted)).toEqual({
      identity: "ready",
      level: "degraded",
      missing: ["COUNTDOWN_REGEX"],
      settled: false,
      reuseReady: false,
      drift: false,
    });
  });
});

describe("freezeKey", () => {
  test("ignores the ticking countdown on the usage row", async () => {
    const ready = await replayFixture("synthetic/continue-wording-answer");
    const ticked = ready.replace("58m left", "57m left");
    expect(ticked).not.toBe(ready);
    expect(freezeKey(ticked)).toBe(freezeKey(ready));
  });

  test("ignores a drifted countdown whose wording misses the countdown regex", async () => {
    const ready = await replayFixture("synthetic/continue-wording-answer");
    const drifted = ready.replace("58m left", "58m remaining");
    expect(COUNTDOWN_REGEX.test(drifted)).toBe(false);
    const ticked = drifted.replace("58m remaining", "57m remaining");
    expect(freezeKey(ticked)).toBe(freezeKey(drifted));
    expect(freezeKey(drifted)).toBe(freezeKey(ready));
  });

  test("ignores the ticking mid-turn chip row", async () => {
    const working = await replayFixture("synthetic/working");
    expect(working).toContain("1m 30s");
    const ticked = working.replace("1m 30s", "1m 31s");
    expect(ticked).not.toBe(working);
    expect(freezeKey(ticked)).toBe(freezeKey(working));
  });

  test("ignores the Freebucks balance and left lines", () => {
    // The balance rows sit outside the composer box, as on the real Welcome and
    // Continue screens; the box is the input box, so it stays in the key.
    const frame = [
      "May use data for AI training",
      " 20/25 Freebucks remaining",
      "Session ended  ·  20 Freebucks left",
      "╭" + "─".repeat(158) + "╮",
      "│" + "  ▍Enter a coding task or / for commands".padEnd(158) + "│",
      "╰" + "─".repeat(158) + "╯",
    ].join("\n");
    expect(freezeKey(frame.replace("20/25", "3/25"))).toBe(freezeKey(frame));
    expect(freezeKey(frame.replace("20 Freebucks left", "7 Freebucks left"))).toBe(freezeKey(frame));
  });

  const ad = (headline: string, second: string): string => {
    const w = 158;
    return [
      "╭" + "─".repeat(w) + "╮",
      "│" + (" " + headline).padEnd(w) + "│",
      "│" + (" " + second).padEnd(w) + "│",
      "╰" + "─".repeat(w) + "╯",
    ].join("\n");
  };
  const insertAboveUsageRow = (working: string, block: string): string => {
    const rows = working.split("\n");
    const usage = rows.findIndex((row) => row.includes("✕ End session"));
    return [...rows.slice(0, usage), ...block.split("\n"), ...rows.slice(usage)].join("\n");
  };

  test("ignores a server-delivered ad box appearing and rotating above the usage row", async () => {
    const working = await replayFixture("synthetic/working");
    const withAdA = insertAboveUsageRow(working, ad("Scale Vector Search With MongoDB", " Get Started  mongodb.com"));
    const withAdB = insertAboveUsageRow(working, ad("Totally Different Ad Campaign", " Shop Now  example.com"));
    expect(withAdA).not.toBe(working);
    expect(freezeKey(withAdA)).toBe(freezeKey(working));
    expect(freezeKey(withAdB)).toBe(freezeKey(withAdA));
  });

  test("ignores the rotating session box and its referral rows", async () => {
    const working = await replayFixture("synthetic/working");
    const sessionBox = (referral: string): string => {
      const w = 60;
      return [
        "┌" + "─".repeat(w) + "┐",
        "│" + " Session active".padEnd(w) + "│",
        "│" + " 5/8 hours remaining".padEnd(w) + "│",
        "│" + (" 🎁 " + referral).padEnd(w) + "│",
        "└" + "─".repeat(w) + "┘",
      ].join("\n");
    };
    const withBox = (referral: string): string => {
      const rows = working.split("\n");
      const chip = rows.findIndex((row) => row.includes("⎘ •"));
      return [...rows.slice(0, chip), ...sessionBox(referral).split("\n"), ...rows.slice(chip)].join("\n");
    };
    expect(freezeKey(withBox("Streak perk: +15 Freebucks every Pacific day"))).toBe(freezeKey(working));
    expect(freezeKey(withBox("Refer a friend: both earn Freebucks"))).toBe(freezeKey(withBox("Streak perk: +15 Freebucks every Pacific day")));
  });

  test("still sees real content change: typed composer text", async () => {
    const working = await replayFixture("synthetic/working");
    const typed = working.replace("Add to the current task (/ for commands)", "fix the login bug");
    expect(freezeKey(typed)).not.toBe(freezeKey(working));
  });

  test("still sees any other screen change", async () => {
    const working = await replayFixture("synthetic/working");
    expect(freezeKey(working + "\nThinking...")).not.toBe(freezeKey(working));
  });
});

describe("screenExcerpt", () => {
  test("keeps the last non-blank lines, right-trimmed", () => {
    const text = ["one   ", "", "two", "   ", "three  ", "", ""].join("\n");
    expect(screenExcerpt(text, 2)).toBe("two\nthree");
    expect(screenExcerpt(text, 10)).toBe("one\ntwo\nthree");
  });
});

describe("errorLines", () => {
  test("returns the known-error lines, trimmed, one per occurrence", () => {
    const error = KNOWN_ERROR_STRINGS[0];
    const text = ["  " + error + "bun", "unrelated", error + '"C:\\x"  '].join("\n");
    expect(errorLines(text)).toEqual([error + "bun", error + '"C:\\x"']);
    expect(errorLines("nothing here")).toEqual([]);
  });
});
