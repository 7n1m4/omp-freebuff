---
name: freebuff
description: Hand one long, independent coding Task to the freebuff CLI (a different model with its own one-hour allowance) while this session keeps working; use when a Task is worth delegating rather than done in-session, and read this before deciding between freebuff_run and doing the work yourself.
---

Delegate one coding Task to the freebuff CLI, a separate agent process with its
own model and its own one-hour usage allowance. Use the skill when a Task is
long and independent enough to be worth handing to that other model, and you
need to choose between `freebuff_run` and doing the work in this session.

## When to use

Use `freebuff_run` for a long, independent Task: a refactor that touches many
files, a migration, a self-contained feature. Not for quick edits or lookups
you can do in-session; a round trip costs minutes.

One Task runs at a time; up to four more wait in the queue. The Task edits YOUR
repo: the Target is your session's working directory resolved to its git root,
mounted into freebuff's Workspace. There is no path parameter. Never submit
while you hold uncommitted work the Task could collide with.

## Return-at-Ack protocol

`freebuff_run { prompt }` returns a submit receipt at the Ack, never the
answer: `{taskId, phase: "working"}`, or `{taskId, phase: "queued", position}`
when another Task is in flight. The answer arrives later as an asynchronous
aside push into your conversation.

`freebuff_progress { taskId? }` is the recovery channel: the same text the push
carries, idempotent. Poll sparingly; the watchdog trips whether or not anyone
polls. Before the Task settles it reports the Phase; after settle, `done`
returns the verbatim answer and `failed` returns the Verdict, the reason and a
screen excerpt. A long answer lives in the Task archive's `answer.md`; the
details carry its `archivePath`.

## Owner session

While your Task is in flight, only the owning session's `freebuff_run`,
`freebuff_progress`, `freebuff_cancel` and `freebuff_screen` calls are
answered. Another session's call, a subagent's included, is refused
`not_owner`, naming the owner. `freebuff_status` is the exception: readable
from any session.

## Cancel

`freebuff_cancel { taskId? }` stops the active Task: Esc, a wait, Ctrl-C up to
three times, then a forced kill. It blocks until the Task settles, about five
seconds, and returns `{taskId, verdict, archivePath?}`; the Instance exits, and
partial progress is archived under the Verdict `cancelled`. The next Task
spawns fresh. A queued Task named by `taskId` is dequeued instead: it never
started, so the result carries no `archivePath`. Queued Tasks behind keep
running.

## Detach

Your own Esc aborts the tool call, not the Task. A working Task keeps running
under its watchdog as a Detached Task, with its Lock and its archive; the
answer still arrives by the aside push or a later `freebuff_progress` poll. An
abort while the Task is queued or submitting cancels it.

## Abandon

If the session or the extension dies mid-flight, nothing resumes the Task: its
archive holds no terminal Verdict, and `freebuff_status` reports it as an
Abandoned Task with its id, prompt, target and time of death. Never re-paste a
half-run prompt yourself; read the archive and decide whether to run it again.

## Doctor

After a freebuff CLI update, the human runs `/freebuff-doctor` before a real
Task: keystroke-whitelist and screen-drift checks over recorded fixtures, with
a `pass` / `degraded` / `fail` report.
