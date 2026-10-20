---
status: accepted (2026-10-18)
---

# ADR-0004: Task state is process-scoped, and session teardown is refcounted

Resolved by [pi-freebuff#8](https://github.com/vadash/pi-freebuff/issues/8), the wayfinder ticket *Cancellation and session death in plugin mode*. Corrects one mechanism fixed by [pi-freebuff#7](https://github.com/vadash/pi-freebuff/issues/7): the watchdog was placed on `ctx.setInterval`.

## Context

OMP binds an extension's factory **per session**, not per process: a subagent session gets its own `ExtensionAPI`, its own tool registry and its own `session_shutdown`, while the module graph — and so module-scope state — is evaluated once and shared process-wide (`oh-my-pi` `extensibility/extensions/loader.ts:560-563`, `sdk.ts:2240`, `extensibility/extensions/wrapper.ts:116-126`).

Three consequences the `ctx`-based lifecycle cannot absorb:

- `session_shutdown` is emitted from `AgentSession.dispose()` and **not** from session switch, branch, resume or `ctx.reload()`, while `session_start` is re-emitted on exactly those paths. A subagent session *is* disposed while the process lives on (park, one-shot, kill).
- `ctx.setInterval`/`setTimeout` are cleared at **that binding's** dispose and never on run abort — so a watchdog created by a subagent's tool call would vanish when that subagent was disposed, while the Task it guards kept running.
- `ctx.reload()` re-evaluates the module graph without firing `session_shutdown`: module state is lost while the Instance and its Lock record live on.

Meanwhile the things being guarded — the Lock, the Workspace, the Instance, the Queue — are machine- and process-level facts (ADR-0001). Nothing about them belongs to a session.

## Decision

- One **process-scoped singleton** owns the Queue, the Lock, the Instance and the Task registry. Any session's tool call joins that one Queue and drives through it; the caller's `ExtensionContext` is used only for what is genuinely per-caller (notifications, status).
- The **Watchdog runs on a process-scoped timer** the extension owns and clears — a plain unref'd `setInterval` with contained throws — never `ctx.setInterval`.
- `session_shutdown` handlers are **refcounted**: the teardown sequence (kill the Instance, append `abandoned@<ts>`, delete the Lock) runs when the **last** session in the process ends, and at the root binding's shutdown. Any other binding's dispose is a no-op. A hard kill runs no JS at all, so nothing may *depend* on the handler having run.
- **Ownership is a pair**: a Lock record is stale when its `ownerPid` is dead, when its `startedAt` is over 30 minutes old, **or** when it names our own pid with no live in-memory Task behind it. The third case is the reload path, reclaimed lazily on the claim path like any other stale record.

## Considered options

- **Keep `ctx.setInterval` and admit the freebuff tools to the top-level session only**: no documented seam marks a binding as "subagent", refusing a subagent's legitimate call buys nothing, and the reload hole stays open regardless.
- **Session-scoped registry with a per-session Lock**: contradicts ADR-0001 (one machine-wide Lock) and would let two sessions in one process fight over one Workspace.
- **Teardown on any binding's dispose**: a parked subagent would kill the Instance and release the Lock of a Task it does not own.
- **Identifying the root binding by session path or role**: undocumented, and the refcount covers the same cases without it.

## Consequences

- Nothing that outlives a turn may hang off `ctx`: timers, the child handle and the Task registry are the extension's own.
- `session_start` may arrive more than once per process (switch, resume, reload) and means nothing about freshness; a second binding must not re-initialise the singleton.
- An in-place reload mid-Task is indistinguishable from a crash from the Task's point of view: the Instance is killed at the next claim and the Task is abandoned — there is no way to type into a handle the re-evaluated module no longer holds.
