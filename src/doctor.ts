// The deterministic doctor core: one pure async pass over the corpus fixtures, the
// recorded classification table, the keystroke evidence and the live screen. Same
// inputs produce byte-identical text — no timestamps, no pids, sorted iteration,
// fixed check order — so the command layer prints the report verbatim.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR } from "./protocol/corpus";
import { RECORDED } from "./protocol/recorded";
import { classifyScreen, flattenScreen, type ScreenRead } from "./protocol/screen";
import { writeScreenDump } from "./protocol/screenDump";
import type { KnownScreen, RecognitionLevel } from "./protocol/signatures";
import { enterWhitelisted } from "./protocol/whitelist";

export type DoctorLevel = "pass" | "degraded" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorLevel;
  detail: string;
}

export interface DoctorReport {
  level: DoctorLevel;
  checks: DoctorCheck[];
  lines: string[];
  text: string;
}

export interface DoctorKeyEvents {
  scenario: "clean-run" | "take-over" | "unnamed-frame";
  events: { event: string }[];
}

export interface DoctorInput {
  /** Corpus root for the drift checks; defaults to the shipped fixture corpus. */
  corpusDir?: string;
  /** The classification every fixture is compared against; defaults to RECORDED. */
  recorded?: Record<string, { screen: KnownScreen | null; level: RecognitionLevel }>;
  /** Observed keystroke sequences; one evidence check per entry, in provided order. */
  keystrokeEvidence?: DoctorKeyEvents[];
  /** The live screen feeding the screen/current check. */
  liveScreen?: { text: string; configDir: string };
}

// The keystroke sequence each scenario may ever produce; anything else means a
// non-whitelisted key escaped.
const EVIDENCE_SEQUENCES: Record<DoctorKeyEvents["scenario"], string[]> = {
  "clean-run": ["spawn", "paste", "submit"],
  "take-over": ["spawn"],
  "unnamed-frame": ["spawn"],
};

export async function runDoctor(input: DoctorInput = {}): Promise<DoctorReport> {
  const corpusDir = input.corpusDir ?? CORPUS_DIR;
  const recorded = input.recorded ?? RECORDED;
  const sortedKeys = Object.keys(recorded).sort();
  const keysWithScreen = (screen: KnownScreen | null): string[] =>
    sortedKeys.filter((key) => recorded[key].screen === screen);
  const checks: DoctorCheck[] = [];

  // The fixture replay exactly as the corpus test does it: PTY-shaped CRLF through
  // the host vterm, then the one screen read.
  const replay = async (key: string): Promise<ScreenRead | null> => {
    try {
      const raw = readFileSync(join(corpusDir, `${key}.ansi`), "utf8").replace(/\n/g, "\r\n");
      return classifyScreen(await flattenScreen([raw]));
    } catch {
      return null;
    }
  };
  const missingSuffix = (read: ScreenRead): string =>
    read.missing.length > 0 ? `, missing ${read.missing.join(", ")}` : "";
  const recognized = (read: ScreenRead): string => `${read.identity}/${read.level}`;

  // For each screen that earns an Enter, the first recorded fixture must recognize
  // at pass and stay whitelisted; a probe row missing from `recorded` skips the rule.
  const whitelistEnter = async (name: string, screen: "cost modal" | "Continue"): Promise<void> => {
    const [probe] = keysWithScreen(screen);
    if (probe === undefined) return;
    const read = await replay(probe);
    if (read === null) {
      checks.push({ name, status: "fail", detail: `probe ${probe}: fixture missing` });
    } else if (read.identity === screen && read.level === "pass" && enterWhitelisted(read.identity, read.level)) {
      checks.push({ name, status: "pass", detail: `probe ${probe}: recognized ${screen}/pass, Enter whitelisted` });
    } else {
      checks.push({
        name,
        status: "fail",
        detail: `probe ${probe}: recorded ${screen}, recognized ${recognized(read)}${missingSuffix(read)}`,
      });
    }
  };
  await whitelistEnter("whitelist/cost-modal-enter", "cost modal");
  await whitelistEnter("whitelist/continue-enter", "Continue");

  // The take-over dialog must recognize cleanly and earn nothing: Enter there would
  // confirm stealing the Hour slot (the Task fails slot_held with zero keystrokes).
  const [takeover] = keysWithScreen("Session-in-use dialog");
  if (takeover !== undefined) {
    const read = await replay(takeover);
    if (read === null) {
      checks.push({ name: "whitelist/take-over-no-enter", status: "fail", detail: `probe ${takeover}: fixture missing` });
    } else if (
      read.identity === "Session-in-use dialog" &&
      read.level === "pass" &&
      !enterWhitelisted(read.identity, read.level)
    ) {
      checks.push({
        name: "whitelist/take-over-no-enter",
        status: "pass",
        detail: `probe ${takeover}: recognized Session-in-use dialog/pass, zero keystrokes at take-over (Task fails slot_held)`,
      });
    } else if (!enterWhitelisted(read.identity, read.level)) {
      checks.push({
        name: "whitelist/take-over-no-enter",
        status: "fail",
        detail: `probe ${takeover}: Enter stays withheld (unnamed frames never earn keys) but recognition broke: recognized ${recognized(read)}${missingSuffix(read)}`,
      });
    } else {
      checks.push({
        name: "whitelist/take-over-no-enter",
        status: "fail",
        detail: `probe ${takeover}: Enter would fire on the take-over dialog: recognized ${recognized(read)}${missingSuffix(read)}`,
      });
    }
  }

  // Every recorded negative frame must stay unnamed: a negative fixture that grows
  // a name, or a key, means the recognizer or the whitelist broke open.
  const negatives = keysWithScreen(null);
  if (negatives.length > 0) {
    const offenders: string[] = [];
    for (const key of negatives) {
      const read = await replay(key);
      if (read === null) offenders.push(`${key}: fixture missing`);
      else if (read.identity !== null || enterWhitelisted(read.identity, read.level))
        offenders.push(`${key}: recognized ${recognized(read)}${missingSuffix(read)}`);
    }
    checks.push({
      name: "whitelist/unnamed-frame-no-keys",
      status: offenders.length === 0 ? "pass" : "fail",
      detail:
        offenders.length === 0
          ? `${negatives.length} negative frames earn zero keystrokes`
          : `${offenders.length} of ${negatives.length} negative frames broke the rule: ${offenders.join("; ")}`,
    });
  }

  for (const item of input.keystrokeEvidence ?? []) {
    const expected = EVIDENCE_SEQUENCES[item.scenario];
    const matches =
      item.events.length === expected.length && expected.every((event, i) => item.events[i].event === event);
    checks.push({
      name: `whitelist/evidence/${item.scenario}`,
      status: matches ? "pass" : "fail",
      detail: matches
        ? `matches [${expected.join(", ")}]`
        : `expected [${expected.join(", ")}], got [${item.events.map((event) => event.event).join(", ")}]`,
    });
  }

  // One drift check per recorded fixture: the replayed frame must still classify
  // exactly as recorded.
  for (const key of sortedKeys) {
    const expected = recorded[key];
    const read = await replay(key);
    if (read === null) {
      checks.push({ name: `drift/${key}`, status: "fail", detail: "fixture missing" });
    } else if (`${read.identity}/${read.level}` === `${expected.screen}/${expected.level}`) {
      checks.push({ name: `drift/${key}`, status: "pass", detail: `matches recorded ${expected.screen}/${expected.level}` });
    } else if (expected.level === "pass" && read.level === "degraded") {
      checks.push({
        name: `drift/${key}`,
        status: "degraded",
        detail: `recorded ${expected.screen}/${expected.level}, recognized ${recognized(read)}, missing ${read.missing.join(", ")}`,
      });
    } else {
      checks.push({
        name: `drift/${key}`,
        status: "fail",
        detail: `recorded ${expected.screen}/${expected.level}, recognized ${recognized(read)}${missingSuffix(read)}`,
      });
    }
  }

  if (input.liveScreen !== undefined) {
    const read = classifyScreen(input.liveScreen.text);
    if (read.level === "degraded") {
      const dump = writeScreenDump(input.liveScreen.configDir, input.liveScreen.text, "degraded");
      checks.push({
        name: "screen/current",
        status: "degraded",
        detail: `current screen: ${read.identity} (${read.level}), ${dump === null ? "dump failed" : `dump ${dump}`}, missing ${read.missing.join(", ")}`,
      });
    } else if (read.identity === null) {
      // ScreenRead.drift is unrecognized-only; degraded recognition has not started drift.
      const dump = writeScreenDump(input.liveScreen.configDir, input.liveScreen.text, "unrecognized");
      checks.push({
        name: "screen/current",
        status: "fail",
        detail: `current screen: unrecognized, ${dump === null ? "dump failed" : `dump ${dump}`}`,
      });
    } else {
      checks.push({
        name: "screen/current",
        status: "pass",
        detail: `current screen: ${read.identity} (${read.level})`,
      });
    }
  }

  const statuses = checks.map((check) => check.status);
  const level: DoctorLevel = statuses.includes("fail")
    ? "fail"
    : statuses.includes("degraded")
      ? "degraded"
      : "pass";
  const count = (status: DoctorLevel): number => checks.filter((check) => check.status === status).length;
  const lines = [
    `freebuff doctor: ${level}`,
    ...checks.map((check) => `  ${check.status}  ${check.name}: ${check.detail}`),
    `${checks.length} checks: ${count("pass")} pass, ${count("degraded")} degraded, ${count("fail")} fail`,
  ];
  return { level, checks, lines, text: lines.join("\n") };
}
