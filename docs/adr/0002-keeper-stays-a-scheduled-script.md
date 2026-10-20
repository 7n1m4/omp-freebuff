---
status: accepted (2026-10-18)
---

# ADR-0002: The streak Keeper stays a scheduled script in this repo

Resolved by [pi-freebuff#5](https://github.com/vadash/pi-freebuff/issues/5), the wayfinder ticket *Workspace and singleton: one directory, one freebuff Instance*.

## Context

The prototype keeps the account's login streak alive with a Windows Scheduled Task (`scripts/streak-keeper.mjs`, registered by `scripts/register-streak-task.ps1`, daily 21:00 local = 18:00 UTC, the allowance reset). It talks to the Supervisor over its named pipe: probe, spawn one if nobody is listening, run one small read-only Task when the chat store shows no activity in the current window, then shut down only a Supervisor it started itself.

In plugin mode there is no pipe and no daemon, and the extension exists only while an OMP session does — while a streak needs one small run on days OMP is never opened.

## Decision

The Keeper stays in this repo as a scheduled script, rewritten to drive freebuff itself:

- It reuses the ported modules (workspace, driver/settle, turnRunner) with no daemon: it spawns the Instance in the Workspace, submits one small read-only Task, waits for Turn end, and shuts down only the Instance it started.
- It reads the **shared** chat store for the current allowance window. One Workspace means one chat-store project key, so an OMP session's work already counts as the day's activity and the Keeper usually exits without spawning at all.
- It obeys ADR-0001's Lock with `kind: 'keeper'`: it waits while a Turn runs, and if the holder is merely idle it reclaims per that ADR. It never touches an Instance it did not start, so the user's own TUI is safe.

## Considered options

- **Retire it**: loses the streak, which the free allowance depends on.
- **Fold it into the extension**: the extension only exists while OMP does; the streak needs a daily run on days OMP is closed.
- **Its own repo or effort**: it is a thin consumer of the ported modules that stay here, and shares the Lock and the Workspace with them. Nothing justifies a second home. (The map's fog line *"Whether the streak keeper stays with this repo or becomes its own thing"* graduates here: it stays.)

## Consequences

- The daily job remains a Windows Scheduled Task, registered by the same setup step as today; since the 2026-10-20 cutover the `Freebuff Streak Keeper` task runs this repo's `scripts/keeper.ts`.
- The Keeper is the second implementer of the Lock protocol, which is what keeps the protocol honest; a single-consumer lock would be over-fit to the extension.
- A day OMP is open and used needs no Keeper action.
