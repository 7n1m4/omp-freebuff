// The PTY driver for one freebuff Instance: spawn over the host seam, screen
// reads through the host vterm, settle via the shared loop, chat-store facts via
// the shared reader. Single-window primitives only — the ack/re-paste policy and
// the verdict mapping live in the turn runner above this seam.
import { PtySession } from "./host/pty";
import { SCREEN_COLS, SCREEN_ROWS } from "./config";
import { CliTerminalScreen, classifyScreen } from "./protocol/screen";
import type { ScreenRead } from "./protocol/screen";
import { writeScreenDump } from "./protocol/screenDump";
import { byNewest, detectTurnEnd, hasLineSince, lineMentionsPrompt, newestChatDir, readChats } from "./protocol/chatStore";
import type { TurnBaseline, TurnEndResult } from "./protocol/chatStore";
import { DEFAULT_PRESS_THROTTLE_MS, awaitSettled } from "./settle";
import type { SettleIo, SettleOutcome } from "./settle";

export type DriverFailureReason =
  | "ready_timeout"
  | "needs_login"
  | "slot_held"
  | "displaced"
  | "ack_missing"
  | "process_exited"
  | "no_answer"
  | "driver_error";

export class FreebuffDriverError extends Error {
  readonly reason: DriverFailureReason;
  readonly excerpt?: string;

  constructor(reason: DriverFailureReason, excerpt?: string) {
    super(excerpt === undefined ? `freebuff driver failure: ${reason}` : `freebuff driver failure: ${reason}: ${excerpt}`);
    this.name = "FreebuffDriverError";
    this.reason = reason;
    this.excerpt = excerpt;
  }
}

export interface DriverTimings {
  /** The settle window: how long waitSettled may wait for a settled screen. */
  settleMs: number;
  /** The Ack window: how long a submit may take to demonstrate it started. */
  ackMs: number;
  /** Chat-store and screen poll interval. */
  pollMs: number;
  /** The paste→Enter delay: the gap that lets the TUI swallow the paste marker. */
  pasteSettleMs: number;
  /** Minimum spacing between solicited Enters (settle.ts shares the constant). */
  pressThrottleMs: number;
}

export const DEFAULT_DRIVER_TIMINGS: DriverTimings = {
  settleMs: 20_000,
  ackMs: 20_000,
  pollMs: 250,
  pasteSettleMs: 150,
  pressThrottleMs: DEFAULT_PRESS_THROTTLE_MS,
};

export interface DriverDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DriverOptions {
  /** Spawn command; tests inject [process.execPath, stubPath]. */
  application: string;
  args?: string[];
  /** PTY cwd — the Workspace; the junction does the rest. */
  workspace: string;
  /** Chat-store root the driver READS; the same value the child gets as FREEBUFF_CONFIG_DIR. */
  freebuffConfigDir: string;
  /** Forwarded to the child (FREEBUFF_STUB_*, ...). */
  env?: Record<string, string>;
  timings?: Partial<DriverTimings>;
  deps?: DriverDeps;
}

// The seam the turn runner scripts against: the whole Instance surface, nothing
// of the PTY mechanics. Tests inject a stub-backed or scripted implementation.
export interface DriverLike {
  alive(): boolean;
  pid(): number | null;
  screenText(): Promise<string>;
  classify(): Promise<ScreenRead>;
  press(data: string): void;
  pastePrompt(text: string): Promise<void>;
  startNewConversation(): Promise<void>;
  waitSettled(opts: { readyMs?: number }): Promise<SettleOutcome>;
  baseline(): TurnBaseline;
  ackSince(baseline: TurnBaseline, prompt: string): boolean;
  turnEndSince(baseline: TurnBaseline): TurnEndResult;
  cancelActive(): Promise<void>;
  kill(): void;
  /** Verbatim chat-store logs of the Turn: the baseline dir plus every newer dir, chronological, for the Task archive. */
  chatLog?(baseline: TurnBaseline | null): string;
  /** Separable child stderr for the archive's stderr.log; a driver whose PTY merges stderr into the screen omits it. */
  stderrText?(): string;
}

// Bracketed paste: a newline inside never submits early; one Enter after the
// end marker submits the whole paste.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const NEW_COMMAND = "/new";
// cancelActive's escalation: three Ctrl-C, this far apart, then the forced kill.
const CTRL_C_PULSE_MS = 400;
const CTRL_C_COUNT = 3;

const realSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export class FreebuffDriver implements DriverLike {
  private readonly options: DriverOptions;
  private readonly timings: DriverTimings;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private pty: PtySession | null = null;
  private screen: CliTerminalScreen | null = null;
  private spawnedPid: number | null = null;
  private exited = false;
  private exitStatus: number | null = null;

  constructor(options: DriverOptions) {
    this.options = options;
    this.timings = { ...DEFAULT_DRIVER_TIMINGS, ...options.timings };
    this.now = options.deps?.now ?? Date.now;
    this.sleep = options.deps?.sleep ?? realSleep;
  }

  async start(): Promise<void> {
    const pty = new PtySession();
    const screen = new CliTerminalScreen();
    this.pty = pty;
    this.screen = screen;
    const started = Promise.withResolvers<void>();
    const run = pty.startArgv(
      {
        application: this.options.application,
        args: this.options.args ?? [],
        cwd: this.options.workspace,
        env: this.childEnv(),
        cols: SCREEN_COLS,
        rows: SCREEN_ROWS,
      },
      (error, chunk) => {
        if (error === null) screen.write(chunk);
      },
      (error, pid) => {
        if (error !== null) started.reject(error);
        else {
          this.spawnedPid = pid;
          started.resolve();
        }
      },
    );
    // The run promise resolving IS the exit: the child kept the PTY open until
    // now, so exitCode/cancelled arrive only here.
    void run.then(
      (result) => {
        this.exited = true;
        this.exitStatus = result.exitCode ?? null;
      },
      () => {
        this.exited = true;
      },
    );
    await started.promise;
  }

  // The child needs the whole parent environment (runtime DLLs, PATH); the
  // driver-owned values are set last so an options.env override cannot bypass them.
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    Object.assign(env, this.options.env);
    env.FREEBUFF_CONFIG_DIR = this.options.freebuffConfigDir;
    env.CODEBUFF_TRUST_AGENT_DIRS = "1";
    return env;
  }

  alive(): boolean {
    return this.pty !== null && !this.exited;
  }

  pid(): number | null {
    return this.exited ? null : this.spawnedPid;
  }

  exitCode(): number | null {
    return this.exitStatus;
  }

  async screenText(): Promise<string> {
    const screen = this.screen;
    if (screen === null) return "";
    await screen.flush();
    return screen.text();
  }

  async classify(): Promise<ScreenRead> {
    return classifyScreen(await this.screenText());
  }

  // The native teardown races the exit callback: post-exit writes throw
  // "PTY session is not running" (pinned in tests/hostPty.test.ts), and that
  // throw IS the exit, so it records the death and surfaces process_exited.
  press(data: string): void {
    const pty = this.pty;
    if (pty === null) throw new FreebuffDriverError("driver_error", "the driver never started");
    if (this.exited) throw new FreebuffDriverError("process_exited");
    try {
      pty.write(data);
    } catch (error) {
      this.exited = true;
      throw new FreebuffDriverError("process_exited", String((error as Error)?.message ?? error));
    }
  }

  async pastePrompt(text: string): Promise<void> {
    this.press(PASTE_START + text + PASTE_END);
    await this.sleep(this.timings.pasteSettleMs);
    this.press("\r");
  }

  // Slash commands are typed as keys so the TUI parses them as commands.
  async startNewConversation(): Promise<void> {
    this.press(NEW_COMMAND);
    await this.sleep(this.timings.pasteSettleMs);
    this.press("\r");
  }

  waitSettled(opts: { readyMs?: number } = {}): Promise<SettleOutcome> {
    const io: SettleIo = {
      read: () => this.screenText(),
      press: (key) => {
        this.press(key);
      },
      sleep: this.sleep,
      now: this.now,
      dump: (text, kind) => {
        writeScreenDump(this.options.freebuffConfigDir, text, kind);
      },
    };
    return awaitSettled(io, {
      readyMs: opts.readyMs ?? this.timings.settleMs,
      pollMs: this.timings.pollMs,
      pressThrottleMs: this.timings.pressThrottleMs,
    });
  }

  baseline(): TurnBaseline {
    const newest = newestChatDir(this.chats());
    return newest === null ? { dirName: "", logBytes: 0 } : { dirName: newest.dirName, logBytes: newest.logBytes };
  }

  // The baseline dir plus every dir newer than it (freebuff rotates dirs per
  // chat); older dirs never carry this Turn's lines.
  ackSince(baseline: TurnBaseline, prompt: string): boolean {
    const snaps = this.chats();
    const base = snaps.find((snap) => snap.dirName === baseline.dirName);
    for (const snap of snaps) {
      if (base !== undefined && snap !== base && byNewest(snap, base) > 0) continue;
      if (hasLineSince(snap, snap === base ? baseline.logBytes : 0, (json) => lineMentionsPrompt(json, prompt))) return true;
    }
    return false;
  }

  turnEndSince(baseline: TurnBaseline): TurnEndResult {
    return detectTurnEnd(this.chats(), baseline);
  }

  // The archive's verbatim chat log: the baseline dir plus every dir newer than
  // it, which is the set ackSince scans because freebuff rotates dirs per chat,
  // oldest first; with no baseline yet, the whole store.
  chatLog(baseline: TurnBaseline | null): string {
    const snaps = this.chats();
    const base = baseline === null ? undefined : snaps.find((snap) => snap.dirName === baseline.dirName);
    return snaps
      .filter((snap) => base === undefined || snap === base || byNewest(snap, base) < 0)
      .sort(byNewest)
      .reverse()
      .map((snap) => snap.logText)
      .join("");
  }

  // No stderrText(): ConPTY merges the child's stderr into the one PTY stream,
  // so there is no separable stderr to capture. Those bytes already surface in
  // the Screen, and the Task archive simply carries no stderr.log.

  // Esc first — the TUI's own cancel; then the Ctrl-C escalation; then the
  // forced kill. A key that lands after the child died is consumed by the
  // native teardown and reports process_exited: tolerated, the kill decides.
  // Cancel is deterministic: it returns only once the death is recorded.
  async cancelActive(): Promise<void> {
    this.toleratedPress("\x1b");
    await this.awaitDeathOr(this.timings.pollMs * 8);
    for (let sent = 0; sent < CTRL_C_COUNT && !this.exited; sent++) {
      this.toleratedPress("\x03");
      await this.sleep(CTRL_C_PULSE_MS);
    }
    await this.awaitDeathOr(this.timings.pollMs * 8);
    this.kill();
    await this.awaitDeathOr(this.timings.pollMs * 8);
  }

  kill(): void {
    const pty = this.pty;
    if (pty === null) return;
    // The kill is decided here; the run promise only carries the exit code.
    this.exited = true;
    try {
      pty.kill();
    } catch {
      // Post-exit kill throws the native not-running error (pinned in
      // tests/hostPty.test.ts): the session is already dead, the no-op is the goal.
    }
  }

  private chats() {
    return readChats(this.options.freebuffConfigDir, this.options.workspace);
  }

  private toleratedPress(data: string): void {
    try {
      this.press(data);
    } catch (error) {
      if (!(error instanceof FreebuffDriverError && error.reason === "process_exited")) throw error;
    }
  }

  // A bounded liveness wait: returns early once the child is dead, otherwise
  // waits out the window at poll granularity.
  private async awaitDeathOr(ms: number): Promise<void> {
    const deadline = this.now() + ms;
    while (!this.exited && this.now() < deadline) await this.sleep(this.timings.pollMs);
  }
}
