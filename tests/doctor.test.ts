// The doctor core at its public seam: runDoctor over the shipped corpus defaults,
// a temp corpus, injected keystroke evidence and a live screen. Determinism is part
// of the contract: same inputs, byte-identical text.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runDoctor } from "../src/doctor";
import { replayFixture } from "./helpers/replay";

// Hand-built 0.2.29-shaped ready frames, as in tests/settle.test.ts: the pass frame
// carries the countdown wording, the degraded frame drops it, so the two isolate the
// drift statuses the doctor reports.
const boxSide = (content: string): string => "│" + content.padEnd(158) + "│";
const composer = (placeholder: string): string =>
  [
    "╭" + "─".repeat(158) + "╮",
    boxSide(""),
    boxSide("  ▍" + placeholder),
    boxSide(""),
    "╰" + "─".repeat(158) + "╯",
  ].join("\n");
const statusRow = (left: string): string =>
  (" " + left).padEnd(160 - "✕ End session".length) + "✕ End session";
const READY_PLACEHOLDER = "Enter a coding task or / for commands";
const readyPassFrame = [statusRow("58m left · 15.2K (1%)"), composer(READY_PLACEHOLDER)].join("\n");
const readyDegradedFrame = [statusRow("15.2K (1%)"), composer(READY_PLACEHOLDER)].join("\n");
const unnamedFrame = ["totally unknown frame", "nothing recognized here"].join("\n");

let corpusDir: string;
let configDir: string;

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), "doctor-corpus-"));
  configDir = mkdtempSync(join(tmpdir(), "doctor-config-"));
  mkdirSync(join(corpusDir, "t"), { recursive: true });
  writeFileSync(join(corpusDir, "t", "pass.ansi"), readyPassFrame);
  writeFileSync(join(corpusDir, "t", "degraded.ansi"), readyDegradedFrame);
  writeFileSync(join(corpusDir, "t", "unnamed.ansi"), unnamedFrame);
});

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const recordedRows = {
  "t/pass": { screen: "ready", level: "pass" },
  "t/degraded": { screen: "ready", level: "pass" },
  "t/unnamed": { screen: "ready", level: "pass" },
} as const;

describe("runDoctor", () => {
  test("default corpus run passes every check and is byte-identical across calls", async () => {
    const first = await runDoctor();
    const second = await runDoctor();
    expect(first.level).toBe("pass");
    expect(first.text).toBe(second.text);
    expect(first.text).toBe(first.lines.join("\n"));
    expect(first.lines[0]).toBe("freebuff doctor: pass");
  });

  test("emits the whitelist block first in fixed order, with the named evidence", async () => {
    const report = await runDoctor();
    const names = report.checks.map((check) => check.name);
    expect(names.slice(0, 4)).toEqual([
      "whitelist/cost-modal-enter",
      "whitelist/continue-enter",
      "whitelist/take-over-no-enter",
      "whitelist/unnamed-frame-no-keys",
    ]);
    expect(names).not.toContain("screen/current");
    expect(report.checks[2].detail).toContain("zero keystrokes");
    expect(report.checks[2].detail).toContain("slot_held");
    expect(report.checks[3].detail).toContain("3");
  });

  test("a whitelist rule whose probe row is absent is not emitted", async () => {
    const report = await runDoctor({ recorded: { "synthetic/continue": { screen: "Continue", level: "pass" } } });
    expect(report.checks.map((check) => check.name)).toEqual([
      "whitelist/continue-enter",
      "drift/synthetic/continue",
    ]);
    expect(report.level).toBe("pass");
  });

  test("evidence checks keep the provided order and fail a wrong sequence", async () => {
    const report = await runDoctor({
      keystrokeEvidence: [
        { scenario: "take-over", events: [{ event: "spawn" }] },
        { scenario: "clean-run", events: [{ event: "spawn" }, { event: "paste" }, { event: "submit" }] },
        { scenario: "unnamed-frame", events: [{ event: "spawn" }] },
      ],
    });
    expect(report.checks.slice(4, 7).map((check) => check.name)).toEqual([
      "whitelist/evidence/take-over",
      "whitelist/evidence/clean-run",
      "whitelist/evidence/unnamed-frame",
    ]);
    expect(report.checks.slice(4, 7).every((check) => check.status === "pass")).toBe(true);

    const broken = await runDoctor({
      keystrokeEvidence: [
        { scenario: "clean-run", events: [{ event: "spawn" }, { event: "submit" }, { event: "paste" }] },
      ],
    });
    const check = broken.checks.find((candidate) => candidate.name === "whitelist/evidence/clean-run");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("[spawn, paste, submit]");
    expect(check?.detail).toContain("[spawn, submit, paste]");
    expect(broken.level).toBe("fail");
  });

  test("drift statuses follow the recorded row vs the replayed fixture", async () => {
    const report = await runDoctor({ corpusDir, recorded: { ...recordedRows } });
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    expect(byName["drift/t/pass"].status).toBe("pass");
    expect(byName["drift/t/degraded"].status).toBe("degraded");
    expect(byName["drift/t/degraded"].detail).toContain("missing");
    expect(byName["drift/t/degraded"].detail).toContain("COUNTDOWN_REGEX");
    expect(byName["drift/t/unnamed"].status).toBe("fail");
    expect(byName["drift/t/unnamed"].detail).toBe("recorded ready/pass, recognized null/fail");
    expect(report.level).toBe("fail");
  });

  test("a recorded row without a fixture fails as fixture missing", async () => {
    const report = await runDoctor({ recorded: { "ghost/nowhere": { screen: "ready", level: "pass" } } });
    const check = report.checks.find((candidate) => candidate.name === "drift/ghost/nowhere");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toBe("fixture missing");
    expect(report.level).toBe("fail");
  });

  test("the live screen check reports pass, degraded with dump, and unrecognized", async () => {
    const ready = await replayFixture("0.2.29/ready");
    const ok = await runDoctor({ liveScreen: { text: ready, configDir } });
    expect(ok.checks.find((candidate) => candidate.name === "screen/current")).toEqual({
      name: "screen/current",
      status: "pass",
      detail: "current screen: ready (pass)",
    });

    const degraded = await runDoctor({ liveScreen: { text: readyDegradedFrame, configDir } });
    const degradedCheck = degraded.checks.find((candidate) => candidate.name === "screen/current");
    expect(degradedCheck?.status).toBe("degraded");
    const dumpMatch = /dump (.+), missing/.exec(degradedCheck?.detail ?? "");
    expect(dumpMatch).not.toBeNull();
    expect(existsSync(dumpMatch?.[1] ?? "")).toBe(true);
    expect(degradedCheck?.detail).toContain("COUNTDOWN_REGEX");

    const unknown = await runDoctor({ liveScreen: { text: unnamedFrame, configDir } });
    const failCheck = unknown.checks.find((candidate) => candidate.name === "screen/current");
    expect(failCheck?.status).toBe("fail");
    expect(failCheck?.detail).toContain("unrecognized");
    expect(unknown.level).toBe("fail");
  });

  test("lines follow the fixed report shape and the footer counts every check", async () => {
    const report = await runDoctor({ corpusDir, recorded: { ...recordedRows } });
    expect(report.lines[0]).toBe(`freebuff doctor: ${report.level}`);
    report.checks.forEach((check, i) => {
      expect(report.lines[i + 1]).toBe(`  ${check.status}  ${check.name}: ${check.detail}`);
    });
    const pass = report.checks.filter((check) => check.status === "pass").length;
    const degraded = report.checks.filter((check) => check.status === "degraded").length;
    const fail = report.checks.filter((check) => check.status === "fail").length;
    expect(report.lines[report.lines.length - 1]).toBe(
      `${report.checks.length} checks: ${pass} pass, ${degraded} degraded, ${fail} fail`,
    );
  });

  test("identical inputs produce byte-identical text, including the dump path", async () => {
    const first = await runDoctor({
      corpusDir,
      recorded: { ...recordedRows },
      liveScreen: { text: readyDegradedFrame, configDir },
    });
    const second = await runDoctor({
      corpusDir,
      recorded: { ...recordedRows },
      liveScreen: { text: readyDegradedFrame, configDir },
    });
    expect(first.text).toBe(second.text);
    expect(first.text).toContain("dump ");
  });
});
