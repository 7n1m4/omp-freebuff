import {
  detectTurnEnd,
  hasLineSince,
  lineMentionsPrompt,
  type ChatDirSnapshot,
  type TurnBaseline,
} from "../../src/protocol/chatStore";
import { classifyScreen, type ScreenRead } from "../../src/protocol/screen";
import type { DriverLike } from "../../src/driver";
import type { SettleOutcome } from "../../src/settle";

// One recorder event per driver-initiated keystroke class, shaped like the stub's
// input log so policy assertions read the same in both tiers.
export type ScriptedEvent =
  | { event: "spawn" }
  | { event: "paste"; text: string }
  | { event: "submit"; text: string }
  | { event: "new"; text: string }
  | { event: "enter"; key: string }
  | { event: "key"; key: string };

/**
 * The Driver stand-in for the turn runner's policy tier: implements DriverLike
 * with no process and no wall time (every wait is the injected sleep, wired to
 * the test's VirtualClock). Branching inputs are plain fields the test mutates
 * between virtual-time steps; `afterPaste`/`onEnter` hooks script the screen and
 * chat-store transitions a real freebuff would produce.
 */
export class ScriptedDriver implements DriverLike {
  isAlive = true;
  readonly pidValue = 4242;
  screen = "";
  // Consumed one per screenText read, then the last frame sticks in `screen`.
  frames: string[] = [];
  settle: SettleOutcome = { ok: true, state: "idle" };
  events: ScriptedEvent[] = [];
  calls = { cancelActive: 0, kill: 0, waitSettled: 0 };
  pasteSettleMs = 10;
  afterPaste: (() => void) | null = null;
  onEnter: (() => void) | null = null;

  // -- store simulation: one chat dir, appended to by the hooks ---------------
  dirName = "chat-0";
  logText = "";
  // Archive inputs the runner reads best-effort after every settle: chatLog
  // mirrors the real driver's turn-dir concatenation, stderr stands in for a
  // separable stderr (ConPTY merges it in production, so it defaults empty).
  stderr = "";

  constructor(private readonly doSleep: (ms: number) => Promise<void>) {}

  // Called by the test's createDriver closure: the runner starts a driver only
  // after the Lock is won, so a spawn event proves the claim was ours.
  started(): void {
    this.events.push({ event: "spawn" });
  }

  append(json: Record<string, unknown>): void {
    this.logText += `${JSON.stringify(json)}\n`;
  }

  ack(prompt: string): void {
    this.append({ msg: prompt });
  }

  endTurn(answer: string | null): void {
    this.append(answer === null ? { shouldEndTurn: true } : { shouldEndTurn: true, data: { fullResponse: answer } });
    this.append({ msg: "Main prompt finished" });
  }

  private snapshot(): ChatDirSnapshot[] {
    return [{ dirName: this.dirName, mtimeMs: 0, logBytes: Buffer.byteLength(this.logText), logText: this.logText }];
  }

  // -- DriverLike -------------------------------------------------------------

  alive(): boolean {
    return this.isAlive;
  }

  pid(): number | null {
    return this.isAlive ? this.pidValue : null;
  }

  async screenText(): Promise<string> {
    const frame = this.frames.shift();
    if (frame !== undefined) this.screen = frame;
    return this.screen;
  }

  async classify(): Promise<ScreenRead> {
    return classifyScreen(await this.screenText());
  }

  press(data: string): void {
    if (data === "\r") {
      this.events.push({ event: "enter", key: data });
      this.onEnter?.();
      return;
    }
    this.events.push({ event: "key", key: data });
  }

  async pastePrompt(text: string): Promise<void> {
    this.events.push({ event: "paste", text });
    await this.doSleep(this.pasteSettleMs);
    this.events.push({ event: "submit", text });
    this.afterPaste?.();
  }

  async startNewConversation(): Promise<void> {
    await this.doSleep(this.pasteSettleMs);
    this.events.push({ event: "new", text: "/new" });
  }

  async waitSettled(): Promise<SettleOutcome> {
    this.calls.waitSettled++;
    return this.settle;
  }

  baseline(): TurnBaseline {
    return { dirName: this.dirName, logBytes: Buffer.byteLength(this.logText) };
  }

  ackSince(baseline: TurnBaseline, prompt: string): boolean {
    return hasLineSince(this.snapshot()[0], baseline.logBytes, (json) => lineMentionsPrompt(json, prompt));
  }

  turnEndSince(baseline: TurnBaseline) {
    return detectTurnEnd(this.snapshot(), baseline);
  }

  chatLog(_baseline: TurnBaseline | null): string {
    return this.logText;
  }

  stderrText(): string {
    return this.stderr;
  }

  async cancelActive(): Promise<void> {
    this.calls.cancelActive++;
  }

  kill(): void {
    this.calls.kill++;
    this.isAlive = false;
  }
}
