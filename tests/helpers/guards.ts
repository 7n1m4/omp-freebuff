// Virtual-time promise guards shared by the singleton and turnRunner suites:
// timers fire only inside VirtualClock.advance, and each advance flushes the
// awaited continuations before the next, so a promise can settle mid-advance.
import type { VirtualClock } from "./virtualClock";

export type Guard<T> = {
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
  done(): boolean;
};

// The rejection handler attaches to the guarded promise at creation: the
// source promise can reject mid-advance, and an unhandled gap makes bun fail
// the test on the spot.
export const guard = <T>(p: Promise<T>): Guard<T> => {
  let settled = false;
  const promise = p.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return { promise, done: () => settled };
};

const driveGuarded = async <T>(
  clock: VirtualClock,
  g: Guard<T>,
  budgetMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  const end = clock.now() + budgetMs;
  while (!g.done() && clock.now() < end) await clock.advance(25);
  if (!g.done()) throw new Error("virtual time budget exhausted before the promise settled");
  return await g.promise;
};

export const driveGuard = async <T>(clock: VirtualClock, g: Guard<T>, budgetMs = 60_000): Promise<T> => {
  const result = await driveGuarded(clock, g, budgetMs);
  if (!result.ok) throw result.error;
  return result.value;
};

// A guard whose promise needs no virtual time (already settled, or settles
// outside the clock): unwrap without driving, throwing a rejected result.
export const unwrapOrThrow = async <T>(g: Guard<T>): Promise<T> => {
  const result = await g.promise;
  if (!result.ok) throw result.error;
  return result.value;
};

export const driveReject = async (clock: VirtualClock, g: Guard<unknown>, budgetMs = 60_000): Promise<unknown> => {
  const result = await driveGuarded(clock, g, budgetMs);
  if (result.ok) throw new Error("expected rejection");
  return result.error;
};

// For rejections that need no virtual time (immediate refusals).
export const rejectionOf = async (clock: VirtualClock, p: Promise<unknown>): Promise<unknown> =>
  driveReject(clock, guard(p));

export const pumpUntil = async (
  clock: VirtualClock,
  predicate: () => boolean,
  opts?: { budgetMs?: number; stepMs?: number; exhausted?: string },
): Promise<void> => {
  const end = clock.now() + (opts?.budgetMs ?? 60_000);
  while (!predicate()) {
    if (clock.now() >= end) throw new Error(opts?.exhausted ?? "virtual time budget exhausted");
    await clock.advance(opts?.stepMs ?? 25);
  }
};
