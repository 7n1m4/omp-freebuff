# pi-freebuff: context

Domain language for this repo: what each word means. The prototype
(`C:\projects\_llm\freebuff-mcp\CONTEXT.md`) is the read-only reference for the
vocabulary inherited from it; every entry below is one this repo fixes or
changes. Grows as wayfinder tickets resolve.

## Glossary

### Processes

- **Extension**: the in-process OMP extension that owns the Instance, the Lock
  and the Queue. Replaces the prototype's *Supervisor*: no daemon, no named pipe,
  no process of its own, and it dies with the OMP session that loaded it.
- **Instance**: one running freebuff process. At most one exists per machine.
  _Avoid:_ "session" (for the process).
- **Owner**: the process holding the Lock — an OMP session's Extension, or the
  Keeper.
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
- **Yield**: the Owner's behaviour when its Instance dies unexpectedly — release
  the Lock and do **not** respawn; the next Task spawns a fresh Instance.
- **Stale Lock**: a record whose `startedAt` is older than 30 minutes, or whose
  `ownerPid` is dead. Reclaimable whatever it claims.

### Work

- **Workspace**: the fixed directory the Instance always runs in,
  `%LOCALAPPDATA%\freebuff-plugin\freebuff-ws`. One per machine, durable, never
  session-derived; its basename is freebuff's chat-store key. It is the
  Instance's stable cwd, not the Hour session's identity.
- **Plugin directory**: `%LOCALAPPDATA%\freebuff-plugin\` — the Lock, the error
  log, screen dumps, and the Workspace.
- **Junction**: the `repo` link inside the Workspace, pointing at the Target
  directory. Swapped only while no Task runs.
- **Target directory**: the OMP session's cwd, resolved to its **git root** (the
  raw cwd when there is no work tree), mounted at `<workspace>/repo`. Filesystem
  roots, the Workspace and its ancestors are refused.
- **Watchdog**: as in the prototype, with one amendment — a failure (freeze,
  crash, deadline) ends the Task, releases the Lock and kills the Instance; the
  respawn is lazy (the next Task), never automatic (ADR-0001). Phases and
  verdicts belong to the turn-lifecycle ticket.
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
