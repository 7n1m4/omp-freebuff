// The process-scoped singleton (ADR-0004): one Queue, one Task registry, one
// Instance drive per OMP process. OMP rebinds the extension factory per
// session, so nothing here hangs off a session: the paint timer is the
// process's own, and a caller's OwnerBinding is touched only for its status
// line and settle push. Every session's tool call joins this one queue through
// getFreebuffSingleton; tasks, phases and ownership outlive any binding.
import { basename } from "node:path";
import { nextTaskId } from "./archive";
import { LockBusyError, readLock, releaseLock } from "./lock";
import {
  ABANDONED,
  TurnRunner,
  type TurnOutcome,
  type TurnPhase,
  type TurnRunnerOptions,
  type Verdict,
} from "./turnRunner";
import { assertSafeTarget, resolveTarget } from "./workspace";

export type Phase = "queued" | TurnPhase | "done" | "failed";

// Fixed by the Phase spec: the runner's step state drives queued/submitting/
// settling, the chat-store ack drives working, the Verdict drives done/failed.
export type PhaseSource = "step-state" | "chat-store" | "verdict";

export interface OwnerBinding {
  sessionId: string;
  /** Human-readable owner identity for refusal messages. */
  label: string;
  hasUI: boolean;
  /** ctx.ui.setStatus wrapper; undefined clears the line. */
  paint(line: string | undefined): void;
  /** pi.sendMessage({...}, {deliverAs:"aside"}) wrapper for the settle result. */
  push(payload: SettlePush): void;
}

export interface SettlePush {
  taskId: string;
  ok: boolean;
  answer?: string;
  verdict?: Verdict;
  message?: string;
  archivePath?: string;
  /** The failed run's last screen lines; absent on success. */
  screenExcerpt?: string;
  /** Known error lines the run's watcher saw; absent when there were none. */
  warnings?: string[];
  elapsedMs: number;
}

export interface SubmitInput {
  prompt: string;
  cwd: string;
  binding: OwnerBinding;
}

export type SubmitOk =
  | { taskId: string; phase: "working" }
  | { taskId: string; phase: "queued"; position: number };

export interface ProgressDetails {
  taskId: string;
  phase: Phase;
  phaseSource: PhaseSource;
  elapsedMs: number;
  verdict?: Verdict;
  answer?: string;
  message?: string;
  archivePath?: string;
  /** Only on failed: the run's last screen lines. */
  screenExcerpt?: string;
  /** Known error lines the run's watcher saw; absent when there were none. */
  warnings?: string[];
  position?: number;
  /** Per-step feed (story 14): present once the working turn has logged a step. */
  steps?: number;
  lastToolCall?: string;
  lastToolResult?: string;
  partialAnswer?: string;
  /** The rendered chat store's block count, sampled at the feed's slow cadence. */
  blocks?: number;
}

export interface SingletonStatus {
  queue: { depth: number; taskIds: string[] };
  activeTask: { taskId: string; phase: Phase } | null;
}

/** What freebuff_cancel returns once the active Task has settled (#22).
 * `verdict: "done"` reports a turn that completed inside the ladder's window — nothing was cancelled. */
export type CancelResult = { taskId: string; verdict: Verdict | "done"; archivePath?: string };

/** What a bounded wait (freebuff_wait, ADR-0008) resolves with: `settled` carries
 * the terminal payload settle() stored — never a recomputation; `timeout` a
 * fresh snapshot of the still-unsettled task; `interrupted` the marker for a
 * user interrupt that ended the task's flight (detach or dequeue), which the
 * tool renders as a snapshot; `none` when nothing owned is unsettled. */
export type WaitOutcome =
  | { kind: "settled"; details: ProgressDetails }
  | { kind: "timeout"; details: ProgressDetails }
  | { kind: "interrupted"; details: ProgressDetails }
  | { kind: "none" };

/** The paint timer's clock; production uses a real unref'd setInterval (ADR-0004).
 * The one-shot pair exists for the bounded waits (ADR-0008): wait timers ride
 * the same injectable clock, so virtual time drives them in tests. */
interface PaintTick {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface FreebuffSingletonDeps {
  /** Process constants every activation's TurnRunner is built from. */
  runner: TurnRunnerOptions;
  /** The paint timer's clock; default is a real unref'd setInterval (ADR-0004). */
  tick?: PaintTick;
  paintTickMs?: number;
}

const MAX_QUEUE = 4;

type SettleFields = Omit<SettlePush, "taskId" | "elapsedMs">;

// Structured refusals: plain objects, so a tool call branches on code without
// instanceof gymnastics.
type Rejection = {
  code: string;
  message: string;
  busy?: boolean;
  position?: number;
  verdict?: Verdict;
};

const fail = (rejection: Rejection): never => {
  throw rejection;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface TaskRecord {
  taskId: string;
  prompt: string;
  target: string;
  ownerSessionId: string;
  ownerLabel: string;
  binding: OwnerBinding;
  phase: Phase;
  phaseSource: PhaseSource;
  submittedAt: number;
  ackedAt: number | undefined;
  settledAt: number | undefined;
  answer: string | undefined;
  verdict: Verdict | undefined;
  message: string | undefined;
  archivePath: string | undefined;
  screenExcerpt: string | undefined;
  warnings: string[];
  pushed: boolean;
  // The activation's full settle (run → settle/drain), so cancel can await the
  // terminal state the funnel wrote.
  settling: Promise<void> | undefined;
  // The structured rejection an abandon ended the task with (lock contention,
  // a broken junction): cancel reports it verbatim instead of a Verdict that
  // does not exist.
  failure: Rejection | undefined;
  // PromiseWithResolvers' type is not in the ES2022 lib; the shape is stable.
  ack: { promise: Promise<SubmitOk>; resolve(value: SubmitOk): void; reject(reason: unknown): void };
}

// One pending bounded wait (ADR-0008), keyed by its task's id. Exactly one
// resolution per waiter — settle, timeout or interrupt — and the timer is
// cleared on every path that resolves earlier than the bound.
interface Waiter {
  task: TaskRecord;
  resolve(outcome: WaitOutcome): void;
  timer: unknown;
}

// A gone binding's paint/push become silent no-ops; the recorded owner session
// id, not this object, still gates every call.
const GONE_BINDING: OwnerBinding = {
  sessionId: "",
  label: "gone binding",
  hasUI: false,
  paint: () => {},
  push: () => {},
};

// The structured rejection teardown answers with (#23): submit refusals after
// the last session ended, and the ack of a Task still mid-submit.
const TORN_DOWN = { code: "torn_down", message: "freebuff is torn down: the last session ended" } as const;

const REAL_TICK: PaintTick = {
  now: Date.now,
  setInterval: (fn: () => void, ms: number): unknown => {
    const id = setInterval(fn, ms);
    id.unref?.(); // never holds the process open (ADR-0004)
    return id;
  },
  clearInterval: (id: unknown): void => {
    clearInterval(id as ReturnType<typeof setInterval>);
  },
  setTimeout: (fn: () => void, ms: number): unknown => {
    const id = setTimeout(fn, ms);
    id.unref?.(); // never holds the process open (ADR-0004)
    return id;
  },
  clearTimeout: (id: unknown): void => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};

export class FreebuffSingleton {
  private readonly runnerOptions: TurnRunnerOptions;
  private readonly tick: PaintTick;
  private readonly paintTickMs: number;
  private readonly tasks = new Map<string, TaskRecord>();
  // Pending bounded waits (ADR-0008) by taskId: each resolves exactly once, on
  // its task's settle, its own timeout or the interrupt that ends its flight.
  private readonly waits = new Map<string, Set<Waiter>>();
  private queue: string[] = [];
  private activeTaskId: string | null = null;
  private runner: TurnRunner | null = null;
  private tickId: unknown;
  // Set once by teardown (#23): the process's last session ended.
  private tornDown = false;

  constructor(deps: FreebuffSingletonDeps) {
    this.runnerOptions = deps.runner;
    this.tick = deps.tick ?? REAL_TICK;
    this.paintTickMs = deps.paintTickMs ?? 1000;
  }

  // -- submit ------------------------------------------------------------------

  // The submit section is fully synchronous (no awaits), so it is atomic on
  // its own: concurrent submits serialize by construction, and the run starts
  // on the caller's clock before any virtual time can pass. The active path
  // hands back the ack promise; it settles when onPhase("working") fires.
  submit(input: SubmitInput): Promise<SubmitOk> {
    if (this.tornDown) return Promise.reject(TORN_DOWN);
    try {
      return this.submitLocked(input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // Synchronous on purpose: gates, target resolution, register + activate or
  // enqueue. Never async — an async body would defer the whole section behind
  // the microtask queue and race the caller's clock.
  private submitLocked(input: SubmitInput): Promise<SubmitOk> {
    for (const task of this.inFlight()) {
      if (task.ownerSessionId !== input.binding.sessionId) {
        fail({ code: "not_owner", message: this.ownerMessage(task) });
      }
    }
    let target: string;
    try {
      target = resolveTarget(input.cwd);
      assertSafeTarget(target, this.runnerOptions.workspace);
    } catch (error) {
      // A caller mistake: the call fails, nothing is allocated or registered.
      throw { code: "bad_target", message: messageOf(error) };
    }
    if (this.activeTaskId !== null) {
      if (this.queue.length >= MAX_QUEUE) {
        fail({
          code: "busy",
          busy: true,
          position: MAX_QUEUE + 1,
          message: `freebuff queue is full: ${MAX_QUEUE} tasks already queued`,
        });
      }
      const task = this.register(input, target, "queued");
      this.queue.push(task.taskId);
      return Promise.resolve({ taskId: task.taskId, phase: "queued", position: this.queue.length });
    }
    const task = this.register(input, target, "submitting");
    this.activate(task);
    return task.ack.promise;
  }

  private register(input: SubmitInput, target: string, phase: Phase): TaskRecord {
    const task: TaskRecord = {
      taskId: nextTaskId(this.now()),
      prompt: input.prompt,
      target,
      ownerSessionId: input.binding.sessionId,
      ownerLabel: input.binding.label,
      binding: input.binding,
      phase,
      phaseSource: "step-state",
      submittedAt: this.now(),
      ackedAt: undefined,
      settledAt: undefined,
      answer: undefined,
      verdict: undefined,
      message: undefined,
      archivePath: undefined,
      screenExcerpt: undefined,
      warnings: [],
      pushed: false,
      settling: undefined,
      failure: undefined,
      ack: Promise.withResolvers<SubmitOk>(),
    };
    // A drained activation may reject with nobody awaiting; the handler keeps
    // that from surfacing as an unhandled rejection.
    task.ack.promise.catch(() => {});
    this.tasks.set(task.taskId, task);
    return task;
  }

  // -- activation --------------------------------------------------------------

  // Per activation: the process-scoped runner drives the Task, carrying the
  // submit-time taskId, this task's phase routing and its Target as per-call
  // overrides. The runner — and with it the live Instance — persists across
  // Tasks (ADR-0001: released with the Lock, kept alive and idle for reuse);
  // the respawn is lazy, on the next activation after a failure dropped it.
  // The junction swap is the runner's, inside the claimed Lock.
  private activate(task: TaskRecord): void {
    this.activeTaskId = task.taskId;
    task.phase = "submitting";
    task.phaseSource = "step-state";
    this.ensureTick();
    this.runner ??= new TurnRunner(this.runnerOptions);
    task.settling = this.runner
      .run(task.prompt, {
        taskId: task.taskId,
        onPhase: (phase) => this.onPhase(task, phase),
        target: task.target,
      })
      .then(
        (outcome) => this.settle(task, this.fieldsOf(outcome)),
        (error) => this.onRunError(task, error),
      );
    // Cancel awaits this promise; a settle-path surprise must never surface as
    // an unhandled rejection.
    task.settling.catch(() => {});
  }

  private onPhase(task: TaskRecord, phase: TurnPhase): void {
    task.phase = phase;
    task.phaseSource = phase === "working" ? "chat-store" : "step-state";
    if (phase === "working") {
      task.ackedAt ??= this.now();
      task.ack.resolve({ taskId: task.taskId, phase: "working" });
    }
  }

  // -- settle ------------------------------------------------------------------

  // The only writer of terminal state, once per settle: record, push exactly
  // once, clear the owner's paint, then drain the queue FIFO.
  private settle(task: TaskRecord, result: SettleFields): void {
    task.phase = result.ok ? "done" : "failed";
    task.phaseSource = "verdict";
    task.settledAt = this.now();
    task.answer = result.answer;
    task.verdict = result.verdict;
    task.message = result.message;
    task.archivePath = result.archivePath;
    task.screenExcerpt = result.screenExcerpt;
    task.warnings = result.warnings ?? [];
    const elapsedMs = this.elapsedMs(task);
    if (task.ackedAt === undefined) {
      // Settled before the ack: the submit call learns of it as a failure.
      task.ack.reject({ code: "submit_failed", verdict: result.verdict, message: result.message ?? "" });
    }
    if (!task.pushed) {
      task.pushed = true;
      try {
        task.binding.push({ taskId: task.taskId, ...result, elapsedMs });
      } catch {
        // A broken binding never fails the settle.
      }
    }
    this.clearPaint(task);
    // The bounded waits (ADR-0008) read the terminal state settle just stored —
    // the only place they ever learn a Verdict from.
    this.resolveWaits(task, { kind: "settled", details: this.detailsOf(task) });
    this.drain();
  }

  private onRunError(task: TaskRecord, error: unknown): void {
    if (error === ABANDONED) {
      // Teardown (#23) owns this settle: the kill, the tombstone, the archive
      // and the Lock release already happened. Nothing is pushed, drained or
      // archived again; the registry is already cleared.
      return;
    }
    if (error instanceof LockBusyError) {
      // Cross-owner contention is a caller mistake, not a Task verdict: the
      // run never started, so there is no settle and nothing to push — the
      // submit call carries the structured rejection.
      this.abandon(task, { code: "lock_busy", message: error.message });
      return;
    }
    // run() contains everything else into outcomes; this is belt and braces.
    this.settle(task, { ok: false, verdict: "driver_error", message: messageOf(error) });
  }

  private fieldsOf(outcome: TurnOutcome): SettleFields {
    return outcome.ok
      ? { ok: true, answer: outcome.answer, archivePath: outcome.archivePath, warnings: outcome.warnings }
      : {
          ok: false,
          verdict: outcome.verdict,
          message: outcome.message,
          archivePath: outcome.archivePath,
          screenExcerpt: outcome.screenExcerpt,
          warnings: outcome.warnings,
        };
  }

  // A task that can never settle (lock contention, a broken junction) still
  // leaves the in-flight set: failed, no Verdict, nothing pushed — the submit
  // caller carries the structured rejection.
  private abandon(task: TaskRecord, rejection: Rejection): void {
    task.phase = "failed";
    task.phaseSource = "verdict";
    task.settledAt = this.now();
    task.message = rejection.message;
    task.failure = rejection;
    this.clearPaint(task);
    // Failed-shaped: a bounded wait reads the abandonment like any settle,
    // under the shared failed rendering.
    this.resolveWaits(task, { kind: "settled", details: this.detailsOf(task) });
    this.drain();
    task.ack.reject(rejection);
  }

  private drain(): void {
    this.activeTaskId = null;
    const next = this.queue.shift();
    if (next === undefined) this.stopTick();
    else this.activate(this.tasks.get(next)!);
  }

  // -- queries -----------------------------------------------------------------

  progress(taskId: string | undefined, binding: OwnerBinding): ProgressDetails {
    this.gate(binding);
    const task = taskId !== undefined ? this.tasks.get(taskId) : (this.active() ?? this.newest());
    if (task === undefined) {
      throw { code: "unknown_task", message: `no freebuff task ${taskId ?? "in flight"}` };
    }
    if (task.ownerSessionId !== binding.sessionId) {
      fail({ code: "not_owner", message: this.ownerMessage(task) });
    }
    return this.detailsOf(task);
  }

  // Truthful only: what the queue and the active slot hold right now.
  statusExtra(): SingletonStatus {
    const active = this.active();
    return {
      queue: { depth: this.queue.length, taskIds: [...this.queue] },
      activeTask: active === undefined ? null : { taskId: active.taskId, phase: active.phase },
    };
  }

  // freebuff_status reports the live Instance pid; the runner owns the driver,
  // so this delegates instead of exposing it.
  instancePid(): number | null {
    return this.runner?.instancePid() ?? null;
  }

  async screenText(binding: OwnerBinding): Promise<string> {
    this.gate(binding);
    const text = await this.runner?.screenText();
    return text ?? fail({ code: "no_instance", message: "no live freebuff instance" });
  }

  // Cancel (#22, ADR-0003): the Owner's stop. It targets only the active Task,
  // takes no taskId, and stops the queue not at all; a queued Task's dequeue
  // lives on the user-interrupt path. The call returns only once the Task has
  // settled, with the truthful verdict: a natural settle that won the race
  // reads as its own, not as cancelled.
  async cancel(binding: OwnerBinding): Promise<CancelResult> {
    this.gate(binding);
    const active = this.active();
    if (active === undefined) {
      throw { code: "no_active_task", message: "no active freebuff task to cancel" };
    }
    this.runner?.cancel();
    await active.settling;
    if (active.phase === "done") {
      // The turn completed inside the ladder's window: the cancel reports the
      // completion instead of a cancelled verdict that never happened.
      return { taskId: active.taskId, verdict: "done", archivePath: active.archivePath };
    }
    if (active.failure !== undefined) {
      // The run ended in an abandon (lock contention, a broken junction): no
      // Verdict exists, so cancel carries the abandonment's own rejection
      // rather than dressing it up as cancelled.
      throw active.failure;
    }
    // A settled failure always carries its Verdict (settle()); the abandon
    // case threw above.
    return { taskId: active.taskId, verdict: active.verdict!, archivePath: active.archivePath };
  }

  // -- wait ---------------------------------------------------------------------

  // The bounded long-poll behind freebuff_wait (ADR-0008): resolves exactly
  // once — at the waited task's settle (the payload settle() stored, never a
  // recomputation), at the timeout bound (with a fresh snapshot), or at the
  // user interrupt that ends the task's flight (the interrupted marker the
  // tool renders as a snapshot). A named already-settled task returns
  // immediately; no taskId waits for the oldest unsettled owned task — the
  // active one first, then queue order — so consecutive waits drain the queue
  // stepwise. Owner-gated like every query; the bound rides the same
  // injectable clock as the paint tick, so virtual time fires it in tests.
  waitOne(binding: OwnerBinding, taskId: string | undefined, timeoutMs: number): Promise<WaitOutcome> {
    this.gate(binding);
    // The taskId-less target is the oldest unsettled owned task — the active
    // slot first, then the queue's head; gate() has already refused any
    // foreign in-flight task, so every candidate here is this session's own.
    const task =
      taskId !== undefined
        ? this.tasks.get(taskId)
        : (this.active() ?? (this.queue.length > 0 ? this.tasks.get(this.queue[0]!) : undefined));
    if (task === undefined) {
      if (taskId !== undefined) fail({ code: "unknown_task", message: `no freebuff task ${taskId}` });
      return Promise.resolve({ kind: "none" });
    }
    if (task.ownerSessionId !== binding.sessionId) {
      fail({ code: "not_owner", message: this.ownerMessage(task) });
    }
    if (task.phase === "done" || task.phase === "failed") {
      return Promise.resolve({ kind: "settled", details: this.detailsOf(task) });
    }
    const wait = Promise.withResolvers<WaitOutcome>();
    const waiter: Waiter = { task, resolve: wait.resolve, timer: undefined };
    waiter.timer = this.tick.setTimeout(() => {
      // The bound consumed its timer: drop the waiter first, so the settle
      // that lands later finds nobody left to resolve.
      this.dropWaiter(task.taskId, waiter);
      wait.resolve({ kind: "timeout", details: this.detailsOf(task) });
    }, timeoutMs);
    const pending = this.waits.get(task.taskId);
    if (pending === undefined) this.waits.set(task.taskId, new Set([waiter]));
    else pending.add(waiter);
    return wait.promise;
  }

  // The User-interrupt seam (#22): OMP aborted the tool call, and the Task's
  // fate follows ADR-0003. A working (or settling) Task with the user-interrupt
  // reason detaches: it keeps its Watchdog and Lock, its answer arrives by the
  // settle push or a later poll. Anything else (queued, submitting, or any
  // other abort reason) is a Cancel. Fire-and-forget and contained: the parked
  // submit call learns through the ack rejection settle() already sends.
  interrupt(binding: OwnerBinding, reason: unknown): void {
    try {
      for (const task of this.inFlight()) {
        if (task.ownerSessionId !== binding.sessionId) continue;
        if (reason === "Interrupted by user" && (task.phase === "working" || task.phase === "settling")) {
          // The detach keeps the Task running (ADR-0003), but a wait on it must
          // not outlive the aborted call: it resolves now, carrying the working
          // snapshot the tool renders as the call's last word. The Task's own
          // settle push still fires when the turn ends.
          this.resolveWaits(task, { kind: "interrupted", details: this.detailsOf(task) });
          continue;
        }
        if (task.phase === "queued") {
          // Snapshot while the record still holds its queue position; the
          // dequeue below takes it out of the flight for good.
          this.resolveWaits(task, { kind: "interrupted", details: this.detailsOf(task) });
          this.queue = this.queue.filter((id) => id !== task.taskId);
          this.tasks.delete(task.taskId);
          task.ack.reject({ code: "cancelled", verdict: "cancelled", message: "task cancelled while queued" });
        } else {
          this.runner?.cancel();
        }
      }
    } catch {
      // An interrupt handler must never throw into the host.
    }
  }

  // #23's seam: the process keeps the tasks, the queue and the runner; only
  // this binding's paint/push go silent.
  bindingGone(sessionId: string): void {
    for (const task of this.tasks.values()) {
      if (task.ownerSessionId === sessionId) task.binding = GONE_BINDING;
    }
  }

  // The last session of the process is gone (#23, ADR-0003): kill the
  // Instance, tombstone and archive the active Task, drop the queued ones
  // unarchived (nothing was ever submitted), then release the Lock and clear
  // the internals. The order is observable; the kill lands before the
  // tombstone, the tombstone before the Lock delete; so a death in between
  // leaves a reclaimable record, not an undrivable orphan. Idempotent, and
  // every step is contained so the release and the dispose always run.
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const id of this.queue) {
      const task = this.tasks.get(id);
      if (task !== undefined) task.ack.reject(TORN_DOWN);
      this.tasks.delete(id);
    }
    this.queue = [];
    const active = this.active();
    if (active !== undefined && active.ackedAt === undefined) active.ack.reject(TORN_DOWN);
    try {
      await this.runner?.abandonActive();
    } catch {
      // The kill and the tombstone are best-effort; the release still follows.
    }
    try {
      // An idle Instance (no run in flight) dies here; after an abandon this
      // is a no-op, because abandonActive already dropped the driver.
      await this.runner?.dispose();
    } catch {
      // Same containment: the release must not depend on the kill.
    }
    // Residual safety: the run's unwind releases the turn-scoped Lock in its
    // own finally. Delete only the record this process holds: while our claim
    // is parked behind a foreign window's or Keeper's live record, the force
    // release would delete THEIR record out from under it.
    const record = readLock(this.runnerOptions.pluginDir);
    if (record?.ownerPid === process.pid) releaseLock(this.runnerOptions.pluginDir);
    this.dispose();
  }

  // -- internals ---------------------------------------------------------------

  private gate(binding: OwnerBinding): void {
    for (const task of this.inFlight()) {
      if (task.ownerSessionId !== binding.sessionId) {
        fail({ code: "not_owner", message: this.ownerMessage(task) });
      }
    }
  }

  // Resolves every pending wait on the task exactly once and clears each
  // timer; the map entry is gone before any promise settles, so a later
  // settle finds nobody left to double-resolve.
  private resolveWaits(task: TaskRecord, outcome: WaitOutcome): void {
    const pending = this.waits.get(task.taskId);
    if (pending === undefined) return;
    this.waits.delete(task.taskId);
    for (const waiter of pending) {
      if (waiter.timer !== undefined) this.tick.clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    }
  }

  // The timeout path's own removal: the fired timer's waiter leaves the set,
  // leaving any co-waiters on the same task untouched.
  private dropWaiter(taskId: string, waiter: Waiter): void {
    const pending = this.waits.get(taskId);
    if (pending === undefined) return;
    pending.delete(waiter);
    if (pending.size === 0) this.waits.delete(taskId);
  }

  private ownerMessage(task: TaskRecord): string {
    return `freebuff is busy with a task owned by ${task.ownerLabel} (${task.ownerSessionId})`;
  }

  // The one ProgressDetails composer, shared by the poll and the bounded
  // wait's snapshots: terminal fields read what settle() stored, the per-step
  // feed (story 14) rides only the active Task — step counter, last tool call
  // and result, the running answer, the rendered block count. A settled or
  // queued Task has no feed to ride.
  private detailsOf(task: TaskRecord): ProgressDetails {
    const details: ProgressDetails = {
      taskId: task.taskId,
      phase: task.phase,
      phaseSource: task.phaseSource,
      elapsedMs: this.elapsedMs(task),
      verdict: task.verdict,
      answer: task.answer,
      message: task.message,
      archivePath: task.archivePath,
      screenExcerpt: task.phase === "failed" ? task.screenExcerpt : undefined,
      warnings: task.warnings.length > 0 ? task.warnings : undefined,
      position: task.phase === "queued" ? this.queue.indexOf(task.taskId) + 1 : undefined,
    };
    const feed = task.taskId === this.activeTaskId ? this.runner?.feedSample() : null;
    if (feed !== null && feed !== undefined) {
      details.steps = feed.step;
      if (feed.lastToolCall !== undefined) details.lastToolCall = feed.lastToolCall;
      if (feed.lastToolResult !== undefined) details.lastToolResult = feed.lastToolResult;
      if (feed.partialAnswer !== undefined) details.partialAnswer = feed.partialAnswer;
      if (feed.blocks !== undefined) details.blocks = feed.blocks;
    }
    return details;
  }

  private active(): TaskRecord | undefined {
    return this.activeTaskId === null ? undefined : this.tasks.get(this.activeTaskId);
  }

  private inFlight(): TaskRecord[] {
    const active = this.active();
    const queued = this.queue.map((id) => this.tasks.get(id)!);
    return active === undefined ? queued : [active, ...queued];
  }

  private newest(): TaskRecord | undefined {
    let newest: TaskRecord | undefined;
    for (const task of this.tasks.values()) {
      if (newest === undefined || task.submittedAt >= newest.submittedAt) newest = task;
    }
    return newest;
  }

  // queued counts from submission; everything from the ack counts from the ack,
  // falling back to the submission when the ack never landed. A settled task's
  // duration is frozen at its settle — later polls report the Task's length,
  // not the time since it finished.
  private elapsedMs(task: TaskRecord): number {
    const at = task.settledAt ?? this.now();
    const from = task.phase !== "queued" && task.ackedAt !== undefined ? task.ackedAt : task.submittedAt;
    return Math.max(0, at - from);
  }

  // The paint timer is process-scoped (ADR-0004): started on first activation,
  // cleared when nothing is in flight, body exception-contained. Never
  // ctx.setInterval, whose auto-clear belongs to a session.
  private ensureTick(): void {
    if (this.tickId !== undefined) return;
    this.tickId = this.tick.setInterval(() => {
      try {
        const task = this.active();
        if (task !== undefined) {
          task.binding.paint(
            `freebuff ${task.taskId} · ${task.phase} · ${Math.floor(this.elapsedMs(task) / 1000)}s · ${basename(task.target)}`,
          );
        }
      } catch {
        // Contained: a broken paint never kills the timer.
      }
    }, this.paintTickMs);
  }

  private stopTick(): void {
    if (this.tickId === undefined) return;
    const id = this.tickId;
    this.tickId = undefined;
    this.tick.clearInterval(id);
  }

  private clearPaint(task: TaskRecord): void {
    try {
      task.binding.paint(undefined);
    } catch {
      // Same containment as the tick body.
    }
  }

  private now(): number {
    return this.tick.now();
  }

  // Clears memory only: the timer, the registry, the queue, the runner. The
  // Instance kill and the Lock release belong to teardown() (#23);
  // resetFreebuffForTests calls this directly because tests manage their own
  // child processes.
  dispose(): void {
    this.stopTick();
    // No awaited bounded wait dangles past a dispose: each pending long-poll
    // resolves on the spot with its task's last snapshot (a teardown empties
    // the flight), and every timer is cleared with it.
    for (const pending of this.waits.values()) {
      for (const waiter of pending) {
        if (waiter.timer !== undefined) this.tick.clearTimeout(waiter.timer);
        waiter.resolve({ kind: "interrupted", details: this.detailsOf(waiter.task) });
      }
    }
    this.waits.clear();
    this.tasks.clear();
    this.queue = [];
    this.activeTaskId = null;
    this.runner = null;
  }
}

let instance: FreebuffSingleton | null = null;

// The memoized process singleton: a session's first call builds it, every later
// call joins it. OMP may re-fire session_start per binding; a second call never
// re-initialises (ADR-0004).
export function getFreebuffSingleton(deps: () => FreebuffSingletonDeps): FreebuffSingleton {
  return (instance ??= new FreebuffSingleton(deps()));
}

// The memo when one exists, never creating: a shutdown-path caller must not
// materialize a singleton just to tear it down.
export function peekFreebuffSingleton(): FreebuffSingleton | undefined {
  return instance ?? undefined;
}

// Drops the memoized instance, the registry, the queue and the paint timer.
// Module state is process-shared across bun test files: call in beforeEach AND
// afterEach.
export function resetFreebuffForTests(): void {
  instance?.dispose();
  instance = null;
}
