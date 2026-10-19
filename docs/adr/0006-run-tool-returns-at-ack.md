---
status: accepted (2026-10-19)
---

# ADR-0006: The run tool returns at the Ack, and the answer rides the aside push

Resolved by [pi-freebuff#20](https://github.com/vadash/pi-freebuff/issues/20), the wayfinder ticket *Async surface: return at Ack, Owner session, queue*.

## Context

The blocking call made the parent's session unusable for up to twenty minutes, and made a hang indistinguishable from a slow model: the caller sat in `freebuff_run` with no result, no timeout of its own, and no way to give up without killing the Task. The tool-call channel also cannot carry the answer when it arrives later — `onUpdate` dies with the tool call and never reaches the model, so streaming progress out of a live tool call buys nothing.

Two facts fix the submit boundary:

- The only moment "your Task never started" is knowable is the Ack, and both sides of it are bounded windows (settle, paste, two ack windows) — everything after it is model time, which is not.
- The map's locked no-steer constraint stands: a settle push may never steer the parent's conversation. OMP's `deliverAs: "aside"` injects at a step boundary while streaming and starts a turn only when the session is idle, which is exactly the delivery semantics the answer needs.

Meanwhile everything the surface guards — the Queue, the Lock, the Instance, the Task registry — already lives on the process-scoped singleton (ADR-0004), so the surface can outlive any one session. And the gate has to exist: extension tools are additive in task subagents, so an unrefused subagent call would submit onto a binding whose session can be disposed mid-Task, pushing an answer into a dead conversation.

## Decision

- `freebuff_run` returns at the Ack: `{taskId, phase: "working"}`, or `{taskId, phase: "queued", position}` when another Task is in flight. It is a submit receipt, never the answer.
- The answer is delivered twice, by design: once as the **settle push** (`deliverAs: "aside"`, the parent treats it as the delivery channel), once as the idempotent **`freebuff_progress` poll** (the recovery channel, verbatim answer on `done`, verdict + message on `failed`).
- One Task at a time per machine, queue depth 4; only the **Owner session's** calls are answered — any other session's `run`/`progress`/`cancel`/`screen` is refused with a message naming the owner.
- The surface hangs off the process-scoped singleton (ADR-0004), so it survives session switches, subagent dispose and in-place reload; a gone binding's paint and push become silent no-ops while the Task keeps its Lock, its Watchdog and its archive.

## Considered options

- **Keep the blocking run tool**: twenty minutes of dead session per Task, and a hang indistinguishable from a slow model.
- **Return a handle and stream progress via `onUpdate`**: the update channel dies with the tool call — nothing reaches the model after the call returns, so the parent could never learn the answer.
- **Steer the answer into the conversation**: violates the map's locked no-steer constraint; a settle push must never re-order or interrupt a turn the human is driving.
- **Let any session's calls through**: a task subagent's call would push an answer onto a binding that is gone, and two sessions could not tell whose Task a refusal or a result belongs to.

## Consequences

- The parent must treat the push as the delivery channel and the poll as the recovery channel; both carry the answer verbatim and untruncated.
- The one-line progress paint shipped with this ticket (the singleton's process-scoped tick); [#21](https://github.com/vadash/pi-freebuff/issues/21) owns the watchdog — the deadline/frozen trips on that same timer shape; [#22](https://github.com/vadash/pi-freebuff/issues/22) the cancel ladder behind `freebuff_cancel`; [#23](https://github.com/vadash/pi-freebuff/issues/23) detach/abandon for Tasks whose caller goes away.
- A refused non-owner call is a normal tool error, not a queue entry: the message names the owner, so a subagent can surface who to ask instead of retrying.
