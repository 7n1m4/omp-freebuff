---
status: accepted (2026-10-18)
---

# ADR-0003: Three endings — cancel, detach, abandon

A Task can stop being driven by the human (cancel), by the parent's turn ending (detach), or by the process dying (abandon); OMP's abort reason (`"Interrupted by user"` vs the default AbortError) distinguishes the first two, and freebuff writes no interrupt marker while neither Esc nor Ctrl-C reliably exits it — only the kill carries the "the Instance exits" contract. Hence: **Cancel** — Esc, a ≤2 s poll, Ctrl-C up to three times 400 ms apart, a poll, then `taskkill /PID <instancePid> /T /F`; the Task yields `cancelled` with the partial answer from the last `shouldEndTurn:false` line, is archived like any settle, and the queue drains. **Detach** — a `working` Task aborted with the user-interrupt reason keeps running under its Watchdog with its Lock held, its answer arriving by the settle push or a later `freebuff_progress`; an abort while `queued` or `submitting`, or with any other reason, is a Cancel. **Abandon** — an archive with no terminal Verdict is an Abandoned Task, inferred at read time and reported by `freebuff_status` (a tenth `abandoned` Verdict would be writable only when the shutdown handler survives — the case that matters least); the last session out kills the Instance, appends `abandoned@<ts>` and deletes the Lock, in that order. Never resume, in any of the three: a half-run coding Task is not idempotent. Resolved by [pi-freebuff#8](https://github.com/vadash/pi-freebuff/issues/8); carries the prototype's never-resubmit rule.

## Consequences

`freebuff_cancel` can block up to ~5 s and must tolerate consumed Ctrl-Cs (draft clear, then exit warning) — three sends, not one. A Detached Task holds the Lock and the slot up to its deadline, unobserved; `freebuff_cancel` is the named way to end it. A queued Task is dropped only by process death: silently and unarchived, because nothing was ever submitted. `meta.json` carries the submitted prompt, since an abandoned Task may have no chat store to identify it by.
