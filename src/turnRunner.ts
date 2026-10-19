// The blocking Task path: one run(prompt) from Lock to Verdict (CONTEXT: Phase
// submitting/working/settling). The whole pipeline lives inside ONE withLock, so
// the Lock release rides withLock's finally on every exit path. Never auto-
// respawns and never re-pastes a half-run Task; on failure the Instance is
// killed and dropped, and the next Task starts fresh. The deadline/frozen/
// cancelled verdicts belong to the watchdog (#21) — every timer here already
// goes through the injected Clock so they slide in without re-cutting.
import {
  DEFAULT_DRIVER_TIMINGS,
  FreebuffDriver,
  FreebuffDriverError,
  type DriverLike,
  type DriverOptions,
  type DriverTimings,
} from "./driver";
import { withLock, type LockDeps } from "./lock";
import { COUNTDOWN_REGEX, END_SESSION } from "./protocol/markers";
import { classifyScreen, EXCERPT_LINES, screenExcerpt } from "./protocol/screen";
import type { TurnBaseline } from "./protocol/chatStore";

// The nine-set from CONTEXT; deadline/frozen/cancelled are produced only by the
// watchdog ticket, never by this runner.
export type Verdict =
  | "ack_missing"
  | "deadline"
  | "frozen"
  | "crashed"
  | "no_answer"
  | "driver_error"
  | "slot_held"
  | "displaced"
  | "cancelled";

/** The timers the runner lives on; production passes `realClock`, tests a virtual one. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const realClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
};

export type TurnOutcome =
  | { ok: true; answer: string }
  | { ok: false; verdict: Verdict; message: string; screenExcerpt?: string };

export interface TurnRunnerOptions {
  /** lock.json home — temp in tests, %LOCALAPPDATA%\freebuff-plugin in production. */
  pluginDir: string;
  /** Spawn cwd for the Instance. */
  workspace: string;
  /** Chat-store root the driver reads; the same value the child gets as FREEBUFF_CONFIG_DIR. */
  freebuffConfigDir: string;
  /** Spawn command; production resolves the freebuff CLI, tests inject the stub. */
  command: { application: string; args?: string[] };
  /** Forwarded to the child (FREEBUFF_STUB_*, ...). */
  env?: Record<string, string>;
  timings?: Partial<DriverTimings>;
  clock?: Clock;
  /** Liveness knobs for the Lock, plus the claim deadline; now/sleep/poll come from clock/timings. */
  lockDeps?: Pick<LockDeps, "isPidAlive" | "killPid" | "hasLiveTask" | "deadlineMs">;
  /** Returns a STARTED driver. Defaults to a real FreebuffDriver on command/env/timings/clock. */
  createDriver?: () => Promise<DriverLike>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly timings: DriverTimings;
  private readonly clock: Clock;
  private driver: DriverLike | null = null;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.timings = { ...DEFAULT_DRIVER_TIMINGS, ...options.timings };
    this.clock = options.clock ?? realClock;
  }

  async run(prompt: string): Promise<TurnOutcome> {
    // LockBusyError (cross-Owner contention) propagates: a caller mistake, not a Task verdict.
    return await withLock(
      this.options.pluginDir,
      "extension",
      {
        now: () => this.clock.now(),
        sleep: (ms) => this.sleep(ms),
        pollMs: this.timings.pollMs,
        isPidAlive: this.options.lockDeps?.isPidAlive,
        killPid: this.options.lockDeps?.killPid,
        hasLiveTask: this.options.lockDeps?.hasLiveTask,
        deadlineMs: this.options.lockDeps?.deadlineMs,
      },
      (lock) => this.runLocked(prompt, lock),
    );
  }

  private async runLocked(prompt: string, lock: { setInstancePid(pid: number): void }): Promise<TurnOutcome> {
    try {
      // 1. Instance: reuse the live one, else spawn. The record names the pid
      // only once the child exists (ADR-0001: it goes down null before that).
      let driver = this.driver;
      if (driver === null || !driver.alive()) {
        driver = await this.startDriver();
        this.driver = driver;
      }
      const pid = driver.pid();
      if (pid !== null) lock.setInstancePid(pid);

      // 2. Settle: idle names a fresh instance, ready a reused one.
      const settled = await driver.waitSettled({});
      if (!settled.ok) {
        const excerpt = settled.excerpt;
        this.dropDriver();
        if (settled.reason === "slot_held") {
          return { ok: false, verdict: "slot_held", message: "the Hour slot is held by another window", screenExcerpt: excerpt };
        }
        if (settled.reason === "displaced") {
          return { ok: false, verdict: "displaced", message: "the Instance was displaced; no keystrokes sent", screenExcerpt: excerpt };
        }
        return { ok: false, verdict: "driver_error", message: `settle failed: ${settled.reason}`, screenExcerpt: excerpt };
      }
      const reused = settled.state === "ready";

      // 3. The fresh footer already reads New chat; only a reused instance /news.
      if (reused) await driver.startNewConversation();

      // 4-5. Baseline, then the prompt as one bracketed paste.
      const baseline: TurnBaseline = driver.baseline();
      await driver.pastePrompt(prompt);

      // 6-7. Two ack windows; the draft Enter substitutes for the re-paste, since
      // the stranded text still sits in the composer.
      const draft = { enterFired: false };
      let acked = await this.ackWindow(driver, baseline, prompt, draft);
      if (!acked) {
        if (!draft.enterFired) await driver.pastePrompt(prompt);
        acked = await this.ackWindow(driver, baseline, prompt, draft);
      }
      if (!acked) {
        await driver.cancelActive();
        const excerpt = await this.excerptOf(driver);
        this.dropDriver();
        return {
          ok: false,
          verdict: "ack_missing",
          message: "no ack within two windows; the submit was cancelled",
          screenExcerpt: excerpt,
        };
      }

      // 8. Turn end. No deadline here — the watchdog (#21) owns it and polls the
      // same two signals: death and the chat-store end line.
      for (;;) {
        if (!driver.alive()) {
          const excerpt = await this.excerptOf(driver);
          this.dropDriver();
          return { ok: false, verdict: "crashed", message: "freebuff exited mid-turn", screenExcerpt: excerpt };
        }
        const end = driver.turnEndSince(baseline);
        if (end.done) {
          if (end.answer !== null) return { ok: true, answer: end.answer };
          return {
            ok: false,
            verdict: "no_answer",
            message: "the turn ended without an answer",
            screenExcerpt: await this.excerptOf(driver),
          };
        }
        await this.sleep(this.timings.pollMs);
      }
    } catch (error) {
      // No errors cross this seam: a mid-submit death is a crash, everything
      // else a driver error. The instance is never respawned inside a run.
      this.dropDriver();
      if (error instanceof FreebuffDriverError && error.reason === "process_exited") {
        return { ok: false, verdict: "crashed", message: messageOf(error) };
      }
      return { ok: false, verdict: "driver_error", message: messageOf(error) };
    }
  }

  // One ack window: a chat-store line naming the prompt or a working screen
  // counts. A draft frame WITH the usage row is the stranded first submit — the
  // text sits in the composer, so exactly one bare Enter per submit recovers it,
  // never a re-paste; without the usage row the frame is displaced-looking and
  // earns nothing. A level-pass cost modal gets at most one confirm Enter per
  // window (the settle throttle does not apply here; the modal is the only
  // confirmable frame). Unnamed frames get nothing.
  private async ackWindow(
    driver: DriverLike,
    baseline: TurnBaseline,
    prompt: string,
    draft: { enterFired: boolean },
  ): Promise<boolean> {
    const deadline = this.clock.now() + this.timings.ackMs;
    let modalConfirmed = false;
    for (;;) {
      if (driver.ackSince(baseline, prompt)) return true;
      const text = await driver.screenText();
      const read = classifyScreen(text);
      if (read.identity === "working") return true;
      if (read.identity === "draft" && !draft.enterFired && (text.includes(END_SESSION) || COUNTDOWN_REGEX.test(text))) {
        draft.enterFired = true;
        driver.press("\r");
      } else if (read.identity === "cost modal" && read.level === "pass" && !modalConfirmed) {
        modalConfirmed = true;
        driver.press("\r");
      }
      if (this.clock.now() >= deadline) return false;
      await this.sleep(this.timings.pollMs);
    }
  }

  private async startDriver(): Promise<DriverLike> {
    if (this.options.createDriver) return await this.options.createDriver();
    const driver = new FreebuffDriver({
      application: this.options.command.application,
      args: this.options.command.args,
      workspace: this.options.workspace,
      freebuffConfigDir: this.options.freebuffConfigDir,
      env: this.options.env,
      timings: this.options.timings,
      deps: { now: () => this.clock.now(), sleep: (ms) => this.sleep(ms) },
    });
    await driver.start();
    return driver;
  }

  // Yield discipline: kill and forget, so the next Task spawns fresh.
  private dropDriver(): void {
    const driver = this.driver;
    this.driver = null;
    driver?.kill();
  }

  private async excerptOf(driver: DriverLike): Promise<string> {
    try {
      return screenExcerpt(await driver.screenText(), EXCERPT_LINES);
    } catch {
      return "";
    }
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.clock.setTimeout(resolve, ms);
    return promise;
  }

  // Kills a live instance (tests, future teardown). Idempotent.
  async dispose(): Promise<void> {
    this.dropDriver();
  }
}
