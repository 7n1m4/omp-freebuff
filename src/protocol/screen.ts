// Screen classification over a real VT emulator (the host vterm); the CLI's
// rendering exceeds hand-rolled VT support, and raw PTY history is not the
// visible screen.
import { Terminal } from "../host/pty";
import { SCREEN_COLS, SCREEN_ROWS } from "../config";
import { COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, FREEBUCKS_LEFT_REGEX, KNOWN_ERROR_STRINGS, STATUS_SEPARATOR } from "./markers";
import { recognizeScreen, bottomBoxEnd, type KnownScreen, type RecognitionLevel } from "./signatures";

/** VT screen state from the host vterm; writes parse behind an ordered queue. */
export class CliTerminalScreen {
  private term = new Terminal({ cols: SCREEN_COLS, rows: SCREEN_ROWS, scrollback: 0, allowProposedApi: true });
  private pending: Promise<void> = Promise.resolve();

  write(chunk: string): void {
    this.pending = this.pending.then(() => new Promise<void>((resolve) => this.term.write(chunk, resolve)));
  }

  flush(): Promise<void> {
    return this.pending;
  }

  text(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < SCREEN_ROWS; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    return lines.join("\n");
  }
}

/** The one screen read: which screen is showing (tolerant recognition) plus the
 *  settle-loop booleans derived from it. Screen identity lives only in identity. */
export interface ScreenRead {
  identity: KnownScreen | "blank" | null;
  level: RecognitionLevel;
  missing: string[];
  /** pass on a screen a new Turn may be submitted into. */
  settled: boolean;
  /** pass on ready: the session screen accepts a pasted task right now. */
  reuseReady: boolean;
  /** Unrecognized only; degraded recognition has not started drift. */
  drift: boolean;
}

export function classifyScreen(text: string): ScreenRead {
  const recognition = recognizeScreen(text);
  return {
    identity: recognition.screen,
    level: recognition.level,
    missing: recognition.missing,
    settled:
      recognition.level === "pass" &&
      (recognition.screen === "ready" || recognition.screen === "Welcome screen" || recognition.screen === "Continue"),
    reuseReady: recognition.level === "pass" && recognition.screen === "ready",
    drift: recognition.screen === null,
  };
}

// A timer line: a parseable countdown line, or any status-line-shaped line carrying
// a bare duration token: drifted wording (`58m remaining`) misses COUNTDOWN_REGEX,
// and the mid-turn chip row (`⎘ • 1m 30s • ■▽`) ticks every second, yet neither may
// ever enter the freeze key, or every frame would hash differently each second and
// a hung turn would never read as frozen. Static lines are identical between
// frames, so over-stripping cannot mask a freeze.
const isTimerLine = (line: string): boolean =>
  COUNTDOWN_REGEX.test(line) ||
  ((line.includes(STATUS_SEPARATOR) || line.includes("•")) &&
    /\b(?:\d+h(?:\s+\d+m)?|\d+m|\d+:\d\d|\d+s)\b/.test(line));

const isBoxRow = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed !== "" && (/^[╭╮╰╯┌┐└┘─═│║]+$/.test(trimmed) || /^│.*│$/.test(trimmed));
};

/** The screen as the watchdog compares it: countdown and Freebucks lines dropped,
 *  and every bordered block except the input box (the bottom-most one) dropped:
 *  server-delivered ads and the rotating session box must not enter the key, while
 *  the welcome info box is static, so dropping it too is harmless. The composer's
 *  rows stay in, so typed text still reads as change. */
export const freezeKey = (text: string): string => {
  const rows = text.split("\n");
  const boxEnd = bottomBoxEnd(rows);
  let boxStart = -1;
  if (boxEnd !== -1) {
    boxStart = boxEnd;
    while (boxStart > 0 && isBoxRow(rows[boxStart - 1])) boxStart -= 1;
  }
  return rows
    .filter((line, i) => {
      if (boxStart <= i && i <= boxEnd) return true;
      if (isBoxRow(line)) return false;
      return !isTimerLine(line) && !FREEBUCKS_BALANCE_REGEX.test(line) && !FREEBUCKS_LEFT_REGEX.test(line);
    })
    .join("\n");
};

/** Screen lines carrying a known error marker, trimmed, one per occurrence, for the error log. */
export const errorLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => KNOWN_ERROR_STRINGS.some((marker) => line.includes(marker)))
    .map((line) => line.trim());

/** The last `count` non-blank screen lines, right-trimmed, for failure messages. */
export const screenExcerpt = (text: string, count: number): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");

export const flattenScreen = async (chunks: string[]): Promise<string> => {
  const screen = new CliTerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  await screen.flush();
  return screen.text();
};
