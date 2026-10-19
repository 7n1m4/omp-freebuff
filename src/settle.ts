// The settle loop as a deep module: the whole "wait until the Instance reaches a
// settled screen" policy behind one function. The Driver passes a PTY-backed
// SettleIo; tests pass a scripted one with a virtual clock — two adapters, one real
// seam. No process, no PTY, no timer of its own: every effect and every tick arrive
// through io.
import { classifyScreen, EXCERPT_LINES, freezeKey, screenExcerpt } from "./protocol/screen";
import { enterWhitelisted } from "./protocol/whitelist";

/** The loop's only effects, injected. press() sends one whitelisted keystroke — the
 *  only key this policy ever sends is "\r", and only into a recognized Continue or
 *  cost-modal frame. dump() receives every degraded/unnamed frame. now()/sleep()
 *  carry the clock, so tests run in virtual time. */
export interface SettleIo {
  read(): Promise<string>;
  press(key: string): Promise<void> | void;
  sleep(ms: number): Promise<void>;
  now(): number;
  dump(text: string, kind: "unrecognized" | "degraded"): void;
}

export type SettleOutcome =
  | { ok: true; state: "idle" | "ready" }
  | { ok: false; reason: "ready_timeout" | "needs_login" | "slot_held" | "displaced"; excerpt: string };

// Prototype ADR-0006 (freebuff-mcp): minimum spacing between solicited Enters, shared by the
// Continue screen and the cost modal so a dialog flip cannot double-press.
export const DEFAULT_PRESS_THROTTLE_MS = 3000;

const DEFAULT_POLL_MS = 250;

// Waits for a settled screen: ready ({state:"ready"}) or the Welcome screen
// ({state:"idle"}). Every decision goes through classifyScreen — nothing here
// matches raw literals. Degraded and unnamed frames never fail early and never earn
// a keystroke; they are dumped and the deadline decides. The take-over dialog and a
// displaced screen fail with zero keystrokes: confirming either would steal or
// misread the Hour slot.
export async function awaitSettled(
  io: SettleIo,
  opts: { readyMs: number; pollMs?: number; pressThrottleMs?: number },
): Promise<SettleOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const throttleMs = opts.pressThrottleMs ?? DEFAULT_PRESS_THROTTLE_MS;
  const deadline = io.now() + opts.readyMs;
  // The window opens at call start: the first Enter fires pressThrottleMs into the
  // call, later Enters no earlier than pressThrottleMs after the previous one.
  let lastPressAt = io.now();
  let continuePressed = false;
  let modalConfirmed = false;
  // One dump per freeze key per kind: a frozen screen repaints (countdown ticks)
  // without changing anything the watchdog compares, and the dump dir must not fill
  // with one screen.
  const dumpedKey: Partial<Record<"unrecognized" | "degraded", string>> = {};
  const dumpOnce = (text: string, kind: "unrecognized" | "degraded"): void => {
    const key = freezeKey(text);
    if (dumpedKey[kind] === key) return;
    dumpedKey[kind] = key;
    io.dump(text, kind);
  };
  // The one keystroke this loop can ever send; throttled under the shared window.
  // Reports whether it fired, so a throttled poll can retry on a later one.
  const tryPress = async (): Promise<boolean> => {
    if (io.now() - lastPressAt < throttleMs) return false;
    await io.press("\r");
    lastPressAt = io.now();
    return true;
  };
  let lastText = "";
  while (io.now() < deadline) {
    const text = await io.read();
    lastText = text;
    const read = classifyScreen(text);
    if (read.level === "degraded") {
      // Drift has started on a named screen: record it, trust nothing, keep polling.
      dumpOnce(text, "degraded");
    } else if (read.identity === null) {
      // Unnamed frame (drift): recorded, never pressed, deadline decides.
      dumpOnce(text, "unrecognized");
    } else if (read.level === "pass") {
      switch (read.identity) {
        case "ready":
          return { ok: true, state: "ready" };
        case "Welcome screen":
          return { ok: true, state: "idle" };
        case "login gate":
          return { ok: false, reason: "needs_login", excerpt: screenExcerpt(text, EXCERPT_LINES) };
        case "Session-in-use dialog":
          // Another window holds the Hour slot; Enter would confirm the take-over.
          return { ok: false, reason: "slot_held", excerpt: screenExcerpt(text, EXCERPT_LINES) };
        case "displaced":
          // This Instance no longer owns the Hour session; pressing keys would
          // type into the window that stole it.
          return { ok: false, reason: "displaced", excerpt: screenExcerpt(text, EXCERPT_LINES) };
        case "Continue":
          // The Hour session is out of credits; one Enter per call re-arms it.
          if (!continuePressed && enterWhitelisted(read.identity, read.level) && (await tryPress()))
            continuePressed = true;
          break;
        case "cost modal":
          // The first submit of a fresh Hour session confirms its cost modal;
          // Esc would leave the draft in the box. One Enter per call.
          if (!modalConfirmed && enterWhitelisted(read.identity, read.level) && (await tryPress()))
            modalConfirmed = true;
          break;
        default:
          // working, draft, connecting, blank: a transient or in-flight screen —
          // wait it out under the same deadline.
          break;
      }
    }
    await io.sleep(pollMs);
  }
  return { ok: false, reason: "ready_timeout", excerpt: screenExcerpt(lastText, EXCERPT_LINES) };
}
