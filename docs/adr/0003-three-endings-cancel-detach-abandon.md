---
status: accepted (2026-10-18)
---

# ADR-0003: Three endings — cancel, detach, abandon

Resolved by [pi-freebuff#8](https://github.com/vadash/pi-freebuff/issues/8), the wayfinder ticket *Cancellation and session death in plugin mode*. Carries the prototype's never-resubmit rule (`freebuff-mcp/docs/adr/0001` §7-8) into this repo.

## Context

A Task can stop being driven for reasons that are not the Task's own: the human stops it, the human stops *the parent*, or the host process goes away. The prototype had one mechanism (`cancel_task` killed the Instance) plus a detached daemon that made the process case vanish entirely. In-process there is no daemon: the extension dies with the OMP process, and the cases had to be separated deliberately.

Three facts force the separation ([research doc](https://github.com/vadash/pi-freebuff/blob/research/omp-lifecycle-cancel-facts/docs/research/2026-10-18-cancel-and-session-death-facts.md)):

- OMP hands the running tool a signal whose `reason` is `"Interrupted by user"` on user Esc, and the default `AbortError` on session end, dispose, switch and internal aborts. The two are distinguishable, so they need not be treated alike.
- freebuff writes **no interrupt marker**: an interrupted turn leaves the last agent step's `fullResponse` with `shouldEndTurn:false`, a `run-state.json` output reading "Partial progress has been preserved", and a live, reusable Instance.
- Neither Esc nor Ctrl-C reliably exits freebuff (`exitOnCtrlC:false`; Ctrl-C clears a draft first, then warns before exiting). Only the kill carries the "the Instance exits" contract.

## Decision

Three endings, decided by *who* stopped the Task.

1. **Cancel** — the Owner stops the active Task: Esc, ≤2 s poll, Ctrl-C up to three times 400 ms apart, ≤2 s poll, then a forced kill through `killPid` (SIGTERM with a bounded SIGKILL escalation on Linux, `taskkill /PID <instancePid> /T /F` on Windows). The Instance exits either way; the Task yields under `cancelled`, is archived like any other settle (partial `fullResponse` taken from the last `shouldEndTurn:false` line), and the queue drains behind it, one fresh Instance per Task.
2. **Detach** — the *parent* stops, the Task does not. A `working` Task whose tool call was aborted with `reason === "Interrupted by user"` keeps running under its Watchdog with its Lock held; its answer arrives by the settle push (`deliverAs:"aside"`) or a later `freebuff_progress`. An abort while `queued` or `submitting`, or with **any other reason**, is a Cancel.
3. **Abandon** — the process goes away and nothing resumes. A Task archive with no terminal Verdict is an **Abandoned Task**, inferred at read time, reported by `freebuff_status`. On the way out — the last session in the process — the extension kills the Instance, appends `abandoned@<ts>` to the phase log and deletes the Lock: kill *before* delete, so a death in between leaves a reclaimable record rather than an undrivable orphan.

Never resume, in any of the three. A half-run coding Task is not idempotent, and re-pasting a prompt whose edits are half-applied is the failure the prototype's ADR-0001 §7 exists to prevent.

## Considered options

- **One ending** (everything kills the Instance, as the prototype effectively did): throws away up to 20 minutes of freebuff work when the human only meant to stop the parent's turn — and in-process the freebuff process runs either way, so the keystroke would be doing the destroying.
- **Resume an abandoned Task** (reclaim the orphan, spawn, re-paste): the prototype considered and rejected it; the archive plus `freebuff_status` gives the human the same information without a blind re-apply.
- **A tenth verdict, `abandoned`**: writable only when the shutdown handler survives — precisely the case that matters least, since a hard kill writes nothing. Inferring from a missing verdict covers both paths with one rule.
- **Cancel by process kill only** (no keystrokes): loses the graceful exit — the server-side slot release and the chat-store flush — that two extra keystrokes buy.
- **Keep the Instance after a cancel** (`/new` on the next Task): buys one avoided respawn, costs a per-Task "is this conversation still sane" read, and killing is already cheap (ADR-0001 §Context).

## Consequences

- `freebuff_cancel` can block up to ~5 s, and its escalation must tolerate consumed Ctrl-Cs (draft clear, then exit warning) — three sends, not one.
- A Detached Task holds the Lock and the account's slot for up to its deadline, unobserved. `freebuff_cancel` is the named way to end it.
- A queued Task is dropped only by process death: silently, and unarchived, because nothing was ever submitted.
- `meta.json` carries the submitted `prompt`: an abandoned Task may have no `chat-messages.json` to identify it by.
