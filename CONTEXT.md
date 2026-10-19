# pi-freebuff: context

Domain language for this repo: what each word means. The prototype
(`C:\projects\_llm\freebuff-mcp\CONTEXT.md`) is the read-only reference for the
vocabulary inherited from it; every entry below is one this repo fixes or
changes. Grows as wayfinder tickets resolve.

## Glossary

### Processes

- **Extension**: the in-process OMP extension that owns the Instance, the Lock
  and the Queue. Replaces the prototype's *Supervisor*: no daemon, no named pipe,
  no process of its own. OMP rebinds its factory **per session** — subagent
  sessions included, each with its own tool registry and its own
  `session_shutdown` — while module-scope state is shared process-wide, so the
  Queue, the Lock and the Instance are **process-scoped**: they live and die with
  the OMP process, never with a session (ADR-0004).
- **Instance**: one running freebuff process. At most one exists per machine.
  _Avoid:_ "session" (for the process).
- **Owner**: the process holding the Lock — an OMP session's Extension, or the
  Keeper.
- **Owner session**: the session whose binding submitted the Task in flight; its
  calls alone are answered — progress paints and the settle push go to that
  binding, and any other session's call is refused with a message naming the
  owner (the queue exists for that one session's rapid submissions).
  _Avoid:_ "user" (a session, not a person).
- **Orphan instance**: a live Instance whose Owner is gone (a hard-killed OMP, a
  crashed Extension). It cannot be driven, because a PTY handle does not cross
  processes, so it is reclaimed, never adopted.
- **Keeper**: the daily streak routine (_prototype: streak keeper_), now a
  scheduled script shipped with this repo. It obeys the Lock, spawns its own
  Instance when the shared chat store shows no activity in the current allowance
  window, and shuts down only an Instance it started.

### Ownership

- **Lock**: the machine-wide record at
  `%LOCALAPPDATA%\freebuff-plugin\lock.json` — the right to drive the Instance.
  It is **turn-scoped**: taken before a Task's spawn, deleted when the Task
  yields its result, on every exit path. It does not track the Instance's
  lifetime. _Avoid:_ "mutex", "pid lock", "supervisor lock" (the prototype's
  daemon lock).
- **Reclaim**: what a claimer does to an Orphan instance or a Stale Lock — kill
  the recorded `instancePid`, delete the record, take the Workspace. Safe
  because the Hour session resumes from the config-dir record, not from the
  directory.
- **Yield**: the Owner's act of ending its drive — release the Lock on every exit
  path, hand the Task's result to the parent, and do **not** respawn; the next
  Task spawns a fresh Instance. It happens when a Task resolves under any
  Verdict, and when the Instance dies unexpectedly.
- **Stale Lock**: a record whose `startedAt` is older than 30 minutes, whose
  `ownerPid` is dead, or which names our own pid with no live Task behind it (an
  Extension reloaded in place). Reclaimable whatever it claims.

### Work

- **Workspace**: the fixed directory the Instance always runs in,
  `%LOCALAPPDATA%\freebuff-plugin\freebuff-ws`. One per machine, durable, never
  session-derived; its basename is freebuff's chat-store key. It is the
  Instance's stable cwd, not the Hour session's identity.
- **Plugin directory**: `%LOCALAPPDATA%\freebuff-plugin\` — the Lock, the error
  log, screen dumps, the Task archive, and the Workspace.
- **Junction**: the `repo` link inside the Workspace, pointing at the Target
  directory. Swapped only while no Task runs.
- **Target directory**: the OMP session's cwd, resolved to its **git root** (the
  raw cwd when there is no work tree), mounted at `<workspace>/repo`. Filesystem
  roots, the Workspace and its ancestors are refused.
- **Watchdog**: the extension's own liveness guard, on a process-scoped timer the
  Extension owns and clears — never `ctx.setInterval`, whose auto-clear belongs to
  a session (ADR-0004) — so it trips whether or not the parent polls. Two trips:
  `deadline` (20 minutes from
  Ack, not from queue entry) and `frozen` (no `log.jsonl` growth **and** no
  Screen change for 3 minutes, timer and ad lines stripped). A trip ends the
  Task under its Verdict, releases the Lock and kills the Instance; the respawn
  is lazy (the next Task), never automatic (ADR-0001).
- **Phase**: what a progress poll reports — `queued`, `submitting` (Lock →
  spawn → settle → paste → Ack), `working` (Ack confirmed, turn in flight),
  `settling` (turn end seen → read the answer, write the Task archive, release
  the Lock), `done`, `failed`. Their sources: the extension's own step state for
  `queued`/`submitting`/`settling`, the `log.jsonl` tail for `working`, the
  Verdict for `done`/`failed`. _Avoid:_ "state" (the Lock's).
- **Verdict**: the terminal classification of a Task — `ack_missing`,
  `deadline`, `frozen`, `crashed`, `no_answer`, `driver_error`, `slot_held`,
  `displaced`, `cancelled`. Only the extension decides a Task is stuck; the
  parent polls and cancels.
- **Cancel**: the Owner's explicit stop of the active Task — the whitelisted Esc
  and Ctrl-C, escalating to a forced kill. The Instance exits, the Task yields
  under `cancelled`, and queued Tasks run on. _Avoid:_ "abort", "interrupt"
  (those are OMP's: see *User interrupt*).
- **User interrupt**: OMP's own Esc, aborting the *parent's* turn — the tool's
  signal carries `Interrupted by user`. Not a Cancel: a Task still `submitting`
  is cancelled, a `working` one is left running as a **Detached Task**.
- **Detached Task**: a `working` Task whose tool call a User interrupt aborted.
  No caller waits on it, so its answer arrives by the settle push or a later
  `freebuff_progress` poll; it keeps its Lock, its Watchdog and its archive.
- **Abandoned Task**: a Task whose Extension died or reloaded mid-flight — its
  Task archive holds no terminal Verdict. Never resumed or re-pasted, reported by
  `freebuff_status`; the human decides whether to run it again.
- **Ack**: as in the prototype — a chat-store line naming the prompt, or the
  Screen showing the working state — with the Screen half re-cut for 0.2.29: the
  composer placeholder `Add to the current task` is the working marker and the
  `working · <n>s · ■ Esc` ticker is retired.
- **Displaced screen**: what an Instance shows after another session took the
  Hour slot: the ready look (transcript, placeholder input box) with the usage
  row replaced by a ticking chip row. Placeholder present **and** usage row
  absent is the discriminator; ridden out with zero keystrokes, the Task fails
  as `displaced`.
- **Draft screen**: the stranded first submit — the submitted text still in the
  composer, the footer chat segment `Chat: New chat`, no welcome box. Classified
  `draft`, never drift; recovered with a single bare Enter, never a re-paste.
- **Task archive**: `<plugin dir>/tasks/<taskId>/` — `meta.json` (phase log,
  Verdict, timings, `instancePid`, model, target repo), `answer.md`
  (`fullResponse`), `chat-messages.json` (verbatim copy), `screen.txt` (the
  frame at settle), `stderr.log` when non-empty. Written on every settle,
  success included.
- **Hour session**: freebuff's one-hour usage window. **Not keyed to a
  directory** in 0.2.29 (verified 2026-10-18): a fresh process resumes an
  unexpired Hour by adopting a `freebuff-live-<pid>.json` record in the freebuff
  config dir whose `ownerPid` is dead and whose `tokenKey` matches the account.
  The prototype's directory lock describes the 0.0.19x CLI.

Everything else in the prototype's glossary — Task, Turn, Queue, Ack, Chat
store, Screen, Marker, Screen signature, Settle loop, Fallback Enter, Doctor,
Drift, Screen dump, Freeze key, Error log, Holding banner, Welcome screen,
Continue screen, Cost modal, Freebucks, Countdown, Active model, Conversation,
Big payload — stays in force until a ticket here amends it.
