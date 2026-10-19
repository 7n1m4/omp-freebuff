/**
 * A deterministic Clock stand-in for tests: timers fire only inside `advance`, in
 * due-time order, with the microtask queue flushed after each callback so awaited
 * turn logic settles before the next timer runs. Ported from the prototype's
 * helper of the same name for the injected-Clock seams later tickets add.
 */
export class VirtualClock {
  private time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  readonly now = (): number => this.time;
  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  readonly setInterval = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn, every: ms });
    return id;
  };
  readonly clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };
  readonly clearInterval = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  /** Runs every timer due within the next `ms`, then lands exactly on `time + ms`. */
  readonly advance = async (ms: number): Promise<void> => {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.time = Math.max(this.time, timer.at);
      if (timer.every === undefined) this.timers.delete(id);
      else timer.at = this.time + timer.every;
      timer.fn();
      // Let awaited continuation of the last callback settle before the next timer.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.time = target;
  };
}
