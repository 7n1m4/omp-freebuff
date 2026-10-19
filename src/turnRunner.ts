// The blocking Task path: one run(prompt) from Lock to Verdict (CONTEXT: Phase
// submitting/working/settling). The whole pipeline lives inside ONE withLock, so
// the Lock release rides withLock's finally on every exit path. Never auto-
// respawns and never re-pastes a half-run Task; on failure the Instance is
// killed and dropped, and the next Task starts fresh. The deadline/frozen
// verdicts come from the runner's own watchdog (#21); cancel() (#22) stops the
// run through this same settle funnel under `cancelled`.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTaskArchive } from "./archive";
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
import { classifyScreen, errorLines, EXCERPT_LINES, freezeKey, screenExcerpt } from "./protocol/screen";
import { partialAnswer as partialAnswerOf, type TurnBaseline } from "./protocol/chatStore";
import { enterWhitelisted } from "./protocol/whitelist";
import { readJunctionTarget } from "./workspace";

// The nine-set from CONTEXT. This runner's own paths produce ack_missing,
// crashed, no_answer, driver_error, slot_held and displaced; its watchdog adds
// deadline/frozen; the cancel path (#22) produces cancelled, carrying the last
// unfinished step's partial answer.
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

/** The runner's own step phases (CONTEXT: Phase); the Verdicts are outcomes, not steps. */
export type TurnPhase = "submitting" | "working" | "settling";

// The abandon unwind (#23): teardown already killed the Instance, tombstoned
// and archived the Task, so the run yields nothing; the singleton must not
// settle, push or archive it again. Identity-compared, never string-matched.
export const ABANDONED = { code: "abandoned", message: "freebuff torn down mid-task" } as const;

/** The timers the runner lives on; production passes `realClock`, tests a virtual one. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

// ADR-0004: the watchdog's timers are extension-owned, so they must never hold
// the host process open — every real timer is created unref'd.
export const realClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
  // The watchdog's freeze poll is the one long-lived timer here (ADR-0004):
  // unref'd so it can never hold the host process open. The real-clock
  // setTimeout stays ref'd — unref'ing every runner sleep starves the real-PTY
  // integration tier on Windows.
  setInterval: (fn, ms) => {
    const id = setInterval(fn, ms);
    id.unref?.();
    return id;
  },
  clearInterval: (id) => clearInterval(id as Parameters<typeof clearInterval>[0]),
};

export type TurnOutcome =
  | { ok: true; answer: string; archivePath?: string; warnings?: string[] }
  | {
      ok: false;
      verdict: Verdict;
      message: string;
      screenExcerpt?: string;
      archivePath?: string;
      warnings?: string[];
      /** The cancelled run's last unfinished step; a cancelled settle archives it as the answer. */
      partialAnswer?: string;
    };

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
  /** Submit-time Task id; pins the archive directory name instead of a generated stamp. */
  taskId?: string;
  /** Observes each phase step, synchronously at the existing phase call sites; a throw is contained. */
  onPhase?: (phase: TurnPhase) => void;
  /** Watchdog knobs (#21); unset values fall to DEADLINE_MS/FREEZE_MS. */
  watchdog?: { deadlineMs?: number; freezeMs?: number };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The run-scoped state abandonActive needs after the run has parked: the phase
// log grows in place, and `abandoned` is the once-guard and the stop flag.
interface ActiveTurn {
  prompt: string;
  startedAt: number;
  taskId: string | undefined;
  phases: string[];
  abandoned: boolean;
}

/** Watchdog deadline: how long a confirmed-working Turn may run before the verdict is `deadline`. */
export const DEADLINE_MS = 20 * 60_000;
/** Watchdog freeze: how long with no chat-store and no screen (freezeKey) change before the verdict is `frozen`. */
export const FREEZE_MS = 3 * 60_000;
/** Error-log watcher poll: how often the working screen is scanned for known error lines. */
export const ERROR_LOG_POLL_MS = 250;

const formatDuration = (ms: number): string => {
  if (ms % 60_000 !== 0) return `${ms / 1000}s`;
  const minutes = ms / 60_000;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly timings: DriverTimings;
  private readonly clock: Clock;
  private driver: DriverLike | null = null;
  // Sticky between runs and cleared when a run begins, so a cancel with no run
  // in flight cannot poison the next one; the checks in runLocked read it.
  private cancelRequested = false;
  // The one run in flight, from run() entry to its settle; abandonActive (#23)
  // claims it once and the abandoned flag is the run's stop signal.
  private activeTurn: ActiveTurn | null = null;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.timings = { ...DEFAULT_DRIVER_TIMINGS, ...options.timings };
    this.clock = options.clock ?? realClock;
  }

  // The Owner's stop request (#22): sticky until the next run picks it up. A
  // live Instance escalates straight to the cancel ladder fire-and-forget,
  // because the ladder always ends in the kill and the run observes the death
  // through its own funnel, so cancel() never awaits it.
  cancel(): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    const driver = this.driver;
    if (driver !== null && driver.alive()) {
      void driver.cancelActive().catch(() => {
        // The forced kill is the last rung; a broken escalation is contained.
      });
    }
  }

  async run(
    prompt: string,
    override?: { taskId?: string; onPhase?: (phase: TurnPhase) => void },
  ): Promise<TurnOutcome> {
    // LockBusyError (cross-Owner contention) propagates: a caller mistake, not a Task verdict.
    this.cancelRequested = false;
    const turn: ActiveTurn = {
      prompt,
      startedAt: this.clock.now(),
      taskId: override?.taskId ?? this.options.taskId,
      phases: [],
      abandoned: false,
    };
    const onPhase = override?.onPhase ?? this.options.onPhase;
    this.activeTurn = turn;
    try {
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
        (lock) => this.runLocked(turn, lock, onPhase),
      );
    } finally {
      this.activeTurn = null;
    }
  }

  // Session-death teardown (#23): the last session is gone. Kills the live
  // Instance before the tombstone, so a death in between leaves a reclaimable
  // record, not an undrivable orphan (ADR-0003), then writes the abandoned
  // archive; meta-only, verdict null; Abandoned is inferred at read time.
  // Returns while the Lock still stands: the run observes `abandoned` at its
  // next checkpoint and unwinds, releasing the Lock in withLock's finally,
  // without a second write or a settle. No-op without an unsettled run.
  async abandonActive(now: number = this.clock.now()): Promise<void> {
    const turn = this.activeTurn;
    if (turn === null || turn.abandoned) return;
    turn.abandoned = true;
    const driver = this.driver;
    const instancePid = driver !== null && driver.alive() ? driver.pid() : null;
    this.dropDriver();
    try {
      writeTaskArchive({
        pluginDir: this.options.pluginDir,
        taskId: turn.taskId,
        now,
        prompt: turn.prompt,
        target: readJunctionTarget(this.options.workspace) ?? null,
        model: this.modelOf(instancePid),
        instancePid,
        verdict: null,
        phaseLog: [...turn.phases, `abandoned@${new Date(now).toISOString()}`],
        startedAt: turn.startedAt,
      });
    } catch {
      // Contained: the kill already landed, so the Lock release must still
      // happen; a lost archive is the price of a clean teardown.
    }
  }

  // Slice 3's freebuff_status/freebuff_screen read the live slot through these,
  // so the async layer never reaches into the private driver.
  instancePid(): number | null {
    const driver = this.driver;
    return driver !== null && driver.alive() ? driver.pid() : null;
  }

  async screenText(): Promise<string | null> {
    const driver = this.driver;
    return driver !== null && driver.alive() ? await driver.screenText() : null;
  }

  private async runLocked(
    turn: ActiveTurn,
    lock: { setInstancePid(pid: number): void },
    onPhase: ((phase: TurnPhase) => void) | undefined,
  ): Promise<TurnOutcome> {
    // Teardown (#23) landed before the claim: the archive exists, so the run
    // unwinds silent; no spawn, no second write. Same guard at every later
    // settle path below.
    if (turn.abandoned) throw ABANDONED;
    const { prompt, startedAt, taskId } = turn;
    const phases = turn.phases;
    // Run-scoped error warnings (#21): the watcher appends here, the outcome
    // carries the accumulation on settle. Per-run by construction, so a later
    // run on the same runner starts with a clean slate and a fresh baseline.
    const warnings: string[] = [];
    // The Turn's chat dirs are named by the baseline, which only exists once taken.
    let baseline: TurnBaseline | null = null;
    const phase = (name: TurnPhase): void => {
      phases.push(`${name}@${new Date(this.clock.now()).toISOString()}`);
      try {
        onPhase?.(name);
      } catch {
        // Contained: a throwing observer must not fail the Turn.
      }
    };
    phase("submitting");
    try {
      // A cancel that arrived between run() and the Lock claim: nothing was
      // spawned, the funnel still archives the empty settle.
      if (this.cancelRequested) {
        const outcome = this.cancelledOutcome(null);
        await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
        this.dropDriver();
        return outcome;
      }
      // An abandon that landed during the claim: nothing spawns, nothing writes.
      if (turn.abandoned) throw ABANDONED;
      // 1. Instance: reuse the live one, else spawn. The record names the pid
      // only once the child exists (ADR-0001: it goes down null before that).
      let driver = this.driver;
      if (driver === null || !driver.alive()) {
        driver = await this.startDriver();
        this.driver = driver;
      }
      // A cancel that landed while the spawn was in flight had no driver to
      // trip; its escalation fires now against the fresh one.
      if (this.cancelRequested) {
        void driver.cancelActive().catch(() => {
          // The forced kill is the last rung; a broken escalation is contained.
        });
      }
      const pid = driver.pid();
      if (pid !== null) lock.setInstancePid(pid);

      // 2. Settle: idle names a fresh instance, ready a reused one.
      const settled = await driver.waitSettled({});
      if (!settled.ok) {
        // The abandon outranks the settle failure: teardown already wrote.
        if (turn.abandoned) throw ABANDONED;
        const excerpt = settled.excerpt;
        let outcome: TurnOutcome;
        if (this.cancelRequested) {
          // The ladder may have killed the Instance mid-wait: the user's stop
          // outranks the settle failure it caused.
          outcome = this.cancelledOutcome(baseline);
        } else if (settled.reason === "slot_held") {
          outcome = { ok: false, verdict: "slot_held", message: "the Hour slot is held by another window", screenExcerpt: excerpt };
        } else if (settled.reason === "displaced") {
          outcome = { ok: false, verdict: "displaced", message: "the Instance was displaced; no keystrokes sent", screenExcerpt: excerpt };
        } else {
          outcome = { ok: false, verdict: "driver_error", message: `settle failed: ${settled.reason}`, screenExcerpt: excerpt };
        }
        await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
        this.dropDriver();
        return outcome;
      }
      const reused = settled.state === "ready";

      // 3. The fresh footer already reads New chat; only a reused instance /news.
      if (reused) await driver.startNewConversation();

      // 4-5. Baseline, then the prompt as one bracketed paste.
      baseline = driver.baseline();
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
        if (turn.abandoned) throw ABANDONED;
        // The stop landed mid-submit: the run was cancelled, not unacked.
        if (this.cancelRequested) {
          const outcome = this.cancelledOutcome(baseline);
          await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
          this.dropDriver();
          return outcome;
        }
        await driver.cancelActive();
        // Abandon checkpoints (#23): an abandon landing inside cancelActive or
        // the excerpt read has already archived this turn as abandoned; the
        // ack_missing settle must not overwrite that archive.
        if (turn.abandoned) throw ABANDONED;
        const screenExcerpt = await this.excerptOf(driver);
        if (turn.abandoned) throw ABANDONED;
        const outcome: TurnOutcome = {
          ok: false,
          verdict: "ack_missing",
          message: "no ack within two windows; the submit was cancelled",
          screenExcerpt,
        };
        await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
        this.dropDriver();
        return outcome;
      }
      phase("working");

      // 8. Turn end, raced against the watchdog (#21) this Ack just armed: the
      // deadline measures from the confirmed Ack, so a slow submit never eats
      // the budget. The loop below only observes; the archive write, the
      // Instance disposition and the settle itself live at this one site.
      const watchdog = this.armWatchdog(driver, warnings);
      try {
        const work = this.workLoop(driver, baseline, phase);
        // The race owns the settle; a post-settle loop death must not surface unhandled.
        work.catch(() => {});
        const raced = await Promise.race([work, watchdog.tripped]);
        // The user's cancel outranks the raced failure: the ladder killed the
        // Instance, so the work loop typically reports crashed first. A
        // success that beat the kill stays truthful, and so does a no_answer —
        // the turn ended by itself; a cancel a tick later does not relabel it.
        const outcome =
          this.cancelRequested && !raced.ok && raced.verdict !== "no_answer"
            ? this.cancelledOutcome(baseline)
            : raced;
        // Stopping before the warnings attach lets the final scan catch lines
        // printed just before the turn ended; the second stop below is a no-op.
        await watchdog.stop();
        // The abandon outranks whatever the race produced: the kill it caused
        // typically reads as crashed, and teardown already archived the Task.
        if (turn.abandoned) throw ABANDONED;
        if (warnings.length > 0) outcome.warnings = warnings;
        await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
        // Kill and yield on every fatal verdict; no_answer keeps the Instance for reuse.
        if (!outcome.ok && outcome.verdict !== "no_answer") this.dropDriver();
        return outcome;
      } finally {
        await watchdog.stop();
      }
    } catch (error) {
      // No errors cross this seam: a mid-submit death is a crash, everything
      // else a driver error. The instance is never respawned inside a run.
      // A stop that killed the Instance mid-submit reads as cancelled instead.
      // The abandon unwind is the one rejection that does cross: it carries
      // ABANDONED out so the singleton leaves the Task to teardown.
      if (turn.abandoned) throw ABANDONED;
      if (this.cancelRequested) {
        const outcome = this.cancelledOutcome(baseline);
        if (warnings.length > 0) outcome.warnings = warnings;
        await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
        this.dropDriver();
        return outcome;
      }
      const outcome: TurnOutcome =
        error instanceof FreebuffDriverError && error.reason === "process_exited"
          ? { ok: false, verdict: "crashed", message: messageOf(error) }
          : { ok: false, verdict: "driver_error", message: messageOf(error) };
      if (warnings.length > 0) outcome.warnings = warnings;
      await this.writeArchive(prompt, startedAt, phases, baseline, outcome, taskId);
      this.dropDriver();
      return outcome;
    }
  }

  // The working phase's poll loop as pure observation: it returns the Turn's own
  // outcome (crashed, settled answer, or no_answer) and never settles the Task
  // itself, because the watchdog race at the call site may have already won.
  private async workLoop(
    driver: DriverLike,
    baseline: TurnBaseline,
    phase: (name: TurnPhase) => void,
  ): Promise<TurnOutcome> {
    for (;;) {
      if (!driver.alive()) {
        return {
          ok: false,
          verdict: "crashed",
          message: "freebuff exited mid-turn",
          screenExcerpt: await this.excerptOf(driver),
        };
      }
      const end = driver.turnEndSince(baseline);
      if (end.done) {
        phase("settling");
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
  }

  // ADR-0004: the watchdog is plain timers owned by this call, never session-
  // scoped. Armed by the confirmed Ack: one deadline timeout, one freeze poll,
  // one error-log watcher. A trip resolves `tripped` exactly once; the race at
  // the call site settles the Task, and stop() (idempotent, awaited) clears
  // every timer and runs the watcher's final scan on every exit path.
  private armWatchdog(driver: DriverLike, warnings: string[]): {
    tripped: Promise<TurnOutcome>;
    stop(): Promise<void>;
  } {
    const deadlineMs = this.options.watchdog?.deadlineMs ?? DEADLINE_MS;
    const freezeMs = this.options.watchdog?.freezeMs ?? FREEZE_MS;
    const trip = Promise.withResolvers<TurnOutcome>();
    let settled = false;
    // The last screen read by a freeze tick; the excerpt an eventual trip carries
    // ("" while no read has succeeded, e.g. a deadline before the first tick).
    let lastScreen = "";
    const fire = (verdict: "deadline" | "frozen", detail: string): void => {
      if (settled) return;
      settled = true;
      const excerpt = screenExcerpt(lastScreen, EXCERPT_LINES);
      trip.resolve({
        ok: false,
        verdict,
        message: `watchdog failure: ${verdict}: ${detail}\nlast screen lines:\n${excerpt}`,
        screenExcerpt: excerpt,
      });
    };
    const deadline = this.clock.setTimeout(
      () => fire("deadline", `still running at its ${formatDuration(deadlineMs)} deadline`),
      deadlineMs,
    );
    // Frozen: neither the chat store nor the screen (freezeKey strips countdown
    // and ad lines, so a ticking timer never reads as life) changed for freezeMs.
    // screenText is async, so a tick is skipped while the previous one is still
    // in flight, and every throw is contained: a broken tick never clears the
    // interval nor fails the run.
    let lastLogSize = driver.logSize();
    let lastKey = "";
    let lastChange = this.clock.now();
    let inFlight = false;
    const pollMs = Math.min(1000, Math.max(50, Math.floor(freezeMs / 4)));
    const freeze = this.clock.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const logSize = driver.logSize();
          const screen = await driver.screenText();
          lastScreen = screen;
          const key = freezeKey(screen);
          if (logSize !== lastLogSize || key !== lastKey) {
            lastLogSize = logSize;
            lastKey = key;
            lastChange = this.clock.now();
          } else if (this.clock.now() - lastChange >= freezeMs) {
            fire("frozen", `no Chat store or Screen change for ${formatDuration(freezeMs)}`);
          }
        } catch {
          // Contained: the interval survives to see the next tick.
        } finally {
          inFlight = false;
        }
      })();
    }, pollMs);
    const errors = this.watchErrors(driver, warnings);
    let stopped = false;
    return {
      tripped: trip.promise,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.clock.clearTimeout(deadline);
        this.clock.clearInterval(freeze);
        await errors.stop();
      },
    };
  }

  // Screen lines carrying a known error marker during the working phase are
  // appended to <pluginDir>/errors.jsonl (ADR-0001) and echoed in the outcome's
  // warnings; nothing here acts on them, so a Verdict is never touched. A line
  // counts once it shows more often than at arm time (earlier turns' copies
  // stay on screen), and warns once per run — the warned set and the outcome
  // accumulator are run-scoped, so a later run with a fresh baseline warns
  // again. Best-effort throughout: a broken read or write never fails the Task.
  private watchErrors(driver: DriverLike, warnings: string[]): { stop(): Promise<void> } {
    const tally = (text: string): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of errorLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    // A dead instance's last screen is not what a respawn would show: the
    // baseline only comes from a live driver at arm time. Scans skip until it
    // has landed, so pre-existing lines never read as new.
    let baseline: Map<string, number> | null = driver.alive() ? null : new Map();
    if (driver.alive()) {
      void driver
        .screenText()
        .then((text) => {
          baseline = tally(text);
        })
        .catch(() => {
          baseline = new Map();
        });
    }
    const warned = new Set<string>();
    const scan = async (): Promise<void> => {
      if (baseline === null) return;
      // Snapshot: the field is reassigned by the arm-time read, so narrowing
      // does not survive the await below.
      const base = baseline;
      try {
        const counts = tally(await driver.screenText());
        const lines = [...counts]
          .filter(([line, count]) => count > (base.get(line) ?? 0) && !warned.has(line))
          .map(([line]) => line);
        if (lines.length === 0) return;
        for (const line of lines) {
          warned.add(line);
          warnings.push(line);
        }
        try {
          appendFileSync(
            join(this.options.pluginDir, "errors.jsonl"),
            `${JSON.stringify({
              time: new Date(this.clock.now()).toISOString(),
              workspace: this.options.workspace,
              lines,
            })}\n`,
          );
        } catch {
          // The log is best-effort; it never fails a Task.
        }
      } catch {
        // Contained: a broken scan survives to the next tick.
      }
    };
    const timer = this.clock.setInterval(() => void scan(), ERROR_LOG_POLL_MS);
    return {
      stop: async () => {
        this.clock.clearInterval(timer);
        // One final scan catches lines printed just before the turn ended.
        await scan();
      },
    };
  }

  // The settling phase's Task archive write, on every settle, success included
  // (ADR-0003; a Task dropped by LockBusyError never got here, so it archives
  // nothing). All capture reads happen while the driver is still held: every
  // failure path drops it only after this returns. The write is best-effort the
  // way writeScreenDump is: an archive failure must never become a Task
  // failure, so the outcome leaves archivePath undefined.
  private async writeArchive(
    prompt: string,
    startedAt: number,
    phases: string[],
    baseline: TurnBaseline | null,
    outcome: TurnOutcome,
    taskId: string | undefined,
  ): Promise<string | undefined> {
    const driver = this.driver;
    let chatMessages = "";
    try {
      chatMessages = driver?.chatLog?.(baseline) ?? "";
    } catch {
      // Archive input unavailable; the empty file beats a failed settle.
    }
    let stderr = "";
    try {
      stderr = driver?.stderrText?.() ?? "";
    } catch {
      // Same best-effort policy as the chat read above.
    }
    const screen = await this.screenOf(driver);
    // Abandon checkpoint (#23): an abandon landing inside the screen read has
    // already archived this turn as abandoned, so the settle's own write must
    // not overwrite it.
    if (this.activeTurn?.abandoned) return undefined;
    try {
      const now = this.clock.now();
      const instancePid = driver?.pid() ?? null;
      const { archivePath } = writeTaskArchive({
        pluginDir: this.options.pluginDir,
        taskId,
        now,
        prompt,
        target: readJunctionTarget(this.options.workspace) ?? null,
        model: this.modelOf(instancePid),
        instancePid,
        verdict: outcome.ok ? null : outcome.verdict,
        phaseLog: [...phases, `${outcome.ok ? "done" : "failed"}@${new Date(now).toISOString()}`],
        startedAt,
        answer: outcome.ok ? outcome.answer : (outcome.partialAnswer ?? ""),
        chatMessages,
        screen,
        stderr,
      });
      outcome.archivePath = archivePath;
      return archivePath;
    } catch {
      // The Verdict outranks the archive; a failed write changes nothing.
      return undefined;
    }
  }

  // The live-slot record naming this pid carries the model the Instance runs;
  // no record or an unreadable store reads as null. Same freebuff-live-*.json
  // family readForeignHolders watches for foreign holders.
  private modelOf(instancePid: number | null): string | null {
    if (instancePid === null) return null;
    try {
      for (const name of readdirSync(this.options.freebuffConfigDir)) {
        if (!name.startsWith("freebuff-live-") || !name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(this.options.freebuffConfigDir, name), "utf8")) as {
            ownerPid?: unknown;
            model?: unknown;
          };
          if (record.ownerPid === instancePid && typeof record.model === "string") return record.model;
        } catch {
          // A torn record skips; another may match.
        }
      }
    } catch {
      // No readable store: no model.
    }
    return null;
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
      if (
        read.identity === "draft" &&
        !draft.enterFired &&
        enterWhitelisted(read.identity, read.level, {
          usageRow: text.includes(END_SESSION) || COUNTDOWN_REGEX.test(text),
        })
      ) {
        draft.enterFired = true;
        driver.press("\r");
      } else if (read.identity === "cost modal" && enterWhitelisted(read.identity, read.level) && !modalConfirmed) {
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

  // The cancelled outcome (#22): the partial answer is read while the driver
  // is still held, so the drop that follows cannot lose it. A run cancelled
  // before any Turn line carries no partial.
  private cancelledOutcome(baseline: TurnBaseline | null): TurnOutcome {
    let partialAnswer: string | undefined;
    if (baseline !== null) {
      try {
        partialAnswer = partialAnswerOf(this.driver?.chatLog?.(baseline) ?? "") ?? undefined;
      } catch {
        partialAnswer = undefined;
      }
    }
    return { ok: false, verdict: "cancelled", message: "task cancelled", partialAnswer };
  }

  // Tolerant full-screen read: a dead or broken driver archives an empty screen
  // instead of failing the settle.
  private async screenOf(driver: DriverLike | null): Promise<string> {
    try {
      return driver === null ? "" : await driver.screenText();
    } catch {
      return "";
    }
  }

  private async excerptOf(driver: DriverLike): Promise<string> {
    return screenExcerpt(await this.screenOf(driver), EXCERPT_LINES);
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.clock.setTimeout(resolve, ms);
    return promise;
  }

  // Kills a live instance (tests; the session-death teardown dispose step). Idempotent.
  async dispose(): Promise<void> {
    this.dropDriver();
  }
}
