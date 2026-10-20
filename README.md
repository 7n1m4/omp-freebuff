# pi-freebuff

An in-process [OMP](https://omp.sh) extension that drives the freebuff CLI's
terminal UI through a PTY. It runs one machine-wide freebuff Instance in one
shared Workspace and exposes five tools, all `loadMode: "essential"`. It is the
in-process replacement for the freebuff-supervisor MCP server/daemon: no
daemon, no named pipe, no process of its own. Windows-only.

The domain language (Instance, Lock, Phase, Verdict, Owner session, Detached
Task, ...) is defined in [CONTEXT.md](CONTEXT.md); this README uses those words
with those meanings. Decisions live in [docs/adr/](docs/adr/).

## Install and update

The repo checkout is the extension package (ADR-0005): `package.json` declares
`omp.extensions: ["./src/index.ts"]`, and OMP loads the extension straight from
the source tree — no build step. Both installs below register the package
through the plugin manager, which loads `package.json#omp.extensions` and scans
the package's `skills/` — so the bundled skill is discovered without config
edits. Either way, reload = OMP restart; there is no hot reload.

Local, from a clone (development: edit the checkout, the link points at it):

```
git clone https://github.com/vadash/pi-freebuff
omp plugin link C:\path\to\pi-freebuff
```

From GitHub, no clone (installs a copy under `~/.omp/plugins`):

```
omp plugin install github:vadash/pi-freebuff
```

Full git URLs work too (`https://github.com/vadash/pi-freebuff`,
`git@github.com:vadash/pi-freebuff.git`). Updates: `git pull` + OMP restart for
a link, `omp plugin upgrade pi-freebuff` + OMP restart for a git install.
`omp plugin uninstall pi-freebuff` removes either.

## Cutover

The old surface is gone as of the 2026-10-20 cutover:

- The `freebuff-supervisor` entry was deleted from
  `%USERPROFILE%\.omp\agent\mcp.json` (backup: `mcp.json.bak-cutover` next to
  it). OMP drives freebuff only through this extension.
- The registered `Freebuff Streak Keeper` scheduled task runs this checkout's
  `scripts\keeper.ts` under bun, same daily trigger with `-StartWhenAvailable`,
  working directory the repo root.
- The prototype repo `C:\projects\_llm\freebuff-mcp` is read-only, kept as the
  port source; its README points here.

A session opened before the cutover still mounts the old MCP server from its
startup config: restart OMP to observe the new surface — there is no hot
reload.

## Prerequisites

- Windows (the Workspace junction, `taskkill`, and the PTY host are
  Windows-specific).
- The freebuff CLI, installed and signed in once.
- [Bun](https://bun.sh) for development (`bun install`, `bun test`,
  `bun run typecheck`).

## Tools

All five tools return errors as
`{isError: true, content: [<message>], details: {code, message, ...}}`; the
`details` extras are listed per error below.

### `freebuff_run { prompt: string }`

Submits one Task and returns at the Ack, never with the answer (ADR-0006):

- `{taskId, phase: "working"}` — the Task is in flight;
- `{taskId, phase: "queued", position}` — another Task holds the Instance.

The answer arrives later as an asynchronous aside push into the submitting
conversation and stays pollable via `freebuff_progress`. One Task runs at a
time; the queue holds four. If the queue is full the call fails with
`{code: "busy", busy: true, position: 5}`. A Target that cannot be mounted
(filesystem root, the Workspace itself or an ancestor) fails with `bad_target`
before anything is allocated. A user Esc aborting the tool call detaches a
working Task and cancels a queued or submitting one (ADR-0003).

### `freebuff_progress { taskId?: string }`

Polls one Task. Omitted `taskId` means the active Task, else the newest. The
`details` carry `{taskId, phase, phaseSource, elapsedMs, verdict?, answer?,
message?, archivePath?, screenExcerpt?, warnings?, position?}`. A `done` Task
returns the verbatim answer as the tool text; a `failed` Task is an
`isError` result carrying the Verdict, the reason and a screen excerpt.
Errors: `unknown_task`, `not_owner`.

### `freebuff_cancel { taskId?: string }`

Stops the active Task through the cancel ladder (Esc, a wait, Ctrl-C up to
three times, then a forced kill) and waits for it to settle, up to about five
seconds, before returning `{taskId, verdict, archivePath?}`. If the Task
finished inside the ladder's window the verdict is `done`. The Instance exits;
the next Task spawns fresh; queued Tasks behind keep running. A queued Task
named by `taskId` is dequeued instead and never started: the result is
`{taskId, verdict: "cancelled"}` with no `archivePath`. Errors: `unknown_task`,
`no_active_task`, `not_owner`.

### `freebuff_status {}`

Diagnostics, readable from any session — the one tool not owner-gated. The
`details` combine the machine facts with this process's queue:
`lock {state, ownerPid?, instancePid?, kind?, startedAt?}`, `instancePid?`,
`target?` (the junction's current destination), `foreign.live`
(`{pid, model, expiresAt}[]`, freebuff's own live-slot records), `archive
{count, totalBytes, newestId?}`, `abandoned[]`, plus `queue {depth, taskIds}`
and `activeTask`.

### `freebuff_screen {}`

Reads the Instance's flattened terminal screen. Owner-gated. Errors:
`not_owner`, `no_instance`.

## `/freebuff-doctor`

A slash command, not a tool: the human runs it after a freebuff CLI update,
before a real Task. It checks the keystroke whitelist and the screen
classification over the recorded fixture corpus, and reads the live screen too
when an Instance is readable. The report is deterministic — same inputs,
byte-identical text — with the shape `{level: "pass" | "degraded" | "fail",
checks: [{name, status, detail}], lines, text}`, and is delivered as an aside
message.

## Keeper

A standalone scheduled script (ADR-0002 — not an in-extension daemon) that
keeps freebuff's Hour-session login streak alive: one small read-only Task a
day. Register it once, by hand:

```
powershell -File scripts\register-keeper-task.ps1
```

The task registers as `Freebuff Streak Keeper` and fires daily at 21:00 local
(18:00 UTC on TRT); the allowance itself resets at 21:00 UTC.
`-StartWhenAvailable` fires a missed slot on the next boot. `-Unregister`
removes the task; `-WhatIf` dry-runs the registration.

Each run (`scripts/keeper.ts`) probes before it touches anything: a chat dir
or a Task archive started at or after 21:00 UTC means the day already had
activity, and a live freebuff Instance from freebuff's own per-pid records
means the slot is taken — the run exits without spawning. Otherwise it takes
the Lock with kind `keeper`, points the Workspace's `repo` junction at the
Target, drives ONE read-only Task ("In one sentence, what does README.md do?
Read only — do not edit anything."), then kills only the Instance it started.
A Lock held past the claim deadline skips the run (never stolen); Abandoned
Tasks are reported in the log, never resumed.

`PI_FREEBUFF_KEEPER_JSON` overrides the run — the same JSON shape as
`PI_FREEBUFF_RUNNER_JSON` plus `target`, e.g. to point a manual run at a test
rig. Progress lines tee to the console and to `keeper.log` in the repo root.

## Live tier and capture

Two gated test modules drive the real installed freebuff CLI. They never run in
CI and skip green unless their flag is set:

```
PI_FREEBUFF_LIVE=1 bun test tests/live.test.ts
PI_FREEBUFF_CAPTURE=1 bun test tests/liveCapture.test.ts
```

Run the live tier before a release, when the installed freebuff version
changes, or when a port defect is suspected; it consumes one real Hour-session
task, so run it deliberately, not in a loop. It proves the version gate, Lock
obedience and one full Task end to end. Run the capture mode when the corpus
needs new screen dumps — it is the re-measure path for a drifted version.

Both build their rig in temp directories (plugin dir, Workspace, a disposable
`git init` Target): `%LOCALAPPDATA%\freebuff-plugin\` is never touched. Only
freebuff's own config dir is real — login state, `freebuff-metadata.json`, and
the capture dumps land there. The Lock is obeyed: with a foreign record held,
the submit waits out its claim deadline and refuses with a message naming the
holder pid; nothing spawns and the record is untouched.

The screen wordings are version-bound: `MEASURED_FREEBUFF_VERSION` in
`src/protocol/recorded.ts` records the version they were measured against, and
a live run against any other version fails before spawning, naming the
`PI_FREEBUFF_CAPTURE=1` re-measure path.

Capture samples the live screen across one Task, writes every unique frame to
`~/.config/manicode/screen-dumps/<version>/` (one file per freeze key), and
prints a promotion-ready table of dump file → identity/level. Promote a dump:

1. Copy it into `tests/fixtures/screen/<version>/`, keeping the hash file
   name.
2. Add its `<version>/<file>` row to `RECORDED` in
   `src/protocol/recorded.ts`, naming the screen it shows.
3. `bun test tests/corpus.test.ts` enforces the corpus contract.
4. Review the captures for private data before committing.

## Verdicts and errors

Every Task ends under exactly one Verdict, a closed set of nine:
`ack_missing`, `deadline`, `frozen`, `crashed`, `no_answer`, `driver_error`,
`slot_held`, `displaced`, `cancelled`. A Task dropped before its first submit
(queue dequeue, session death) archives nothing or no Verdict; an archive
without a terminal Verdict reads as an Abandoned Task.

Caller mistakes and freebuff failures are distinct. Refusals (`busy`,
`bad_target`, `unknown_task`, `no_active_task`, `not_owner`, `no_instance`,
`lock_busy`, `torn_down`) are structured tool errors naming what to change;
a Task failure is an `isError` result carrying the Verdict, the reason, and a
screen excerpt with the last lines the Instance showed.

Between submit and settle a Task moves through the Phases: `queued`,
`submitting`, `working`, `settling`, then `done` or `failed`.

## On disk

Everything lands in the plugin directory `%LOCALAPPDATA%\freebuff-plugin\`:

- `lock.json` — the turn-scoped Lock, `{ownerPid, instancePid, kind, startedAt}`
  (`kind` is `extension` or `keeper`); taken before a Task's spawn, deleted on
  every exit path.
- `errors.jsonl` — error lines the run watcher saw on the screen.
- `tasks/<taskId>/` — the Task archive, written on every settle, success
  included: `meta.json` (phase log, Verdict, timings, model, target),
  `answer.md` (the full answer), `chat-messages.json`, `screen.txt`, and
  `stderr.log` when non-empty. Never auto-pruned.
- `freebuff-ws\` — the Workspace, the Instance's fixed working directory, with
  the `repo` junction pointing at the Target (the session's cwd resolved to its
  git root).

Screen dumps are the one thing outside the plugin directory:
`~/.config/manicode/screen-dumps/<version>/` — under freebuff's own config dir
— holds the degraded and unrecognized frames the settle loop dumped, one file
per freeze key, write-only.

## Repository layout

- `src/index.ts` — extension factory: the five tools, `/freebuff-doctor`,
  per-session owner bindings.
- `src/singleton.ts` — the process-scoped singleton: queue, Task registry,
  ownership gate, Instance drive.
- `src/turnRunner.ts` — one Task from Lock to Verdict: submit, Ack, watchdog,
  archive.
- `src/driver.ts` — the PTY driver for one Instance: spawn, whitelisted
  keystrokes, screen reads, cancel ladder.
- `src/settle.ts` — the settled-screen policy behind one function.
- `src/lock.ts` — the `lock.json` record: take, classify, reclaim.
- `src/workspace.ts` — Workspace directory, `repo` junction, Target resolution
  and safety.
- `src/status.ts` — `freebuff_status` data assembly.
- `src/archive.ts` — Task archive writes and Abandoned-Task inference.
- `src/config.ts` — screen geometry (48×160), the size every fixture captures.
- `src/doctor.ts` — the deterministic doctor core.
- `src/protocol/` — screen emulator and classifier, screen signatures, chat
  store reader, keystroke whitelist, fixture corpus, recorded classification
  table, markers.
- `src/host/pty.ts` — the only host-internals seam (`@oh-my-pi/pi-natives`,
  `@oh-my-pi/pi-utils/vterm`); enforced by `tests/hostSeam.test.ts`.
- `src/keeper.ts` — the Keeper core: activity window, probe, one keeper Task.
- `scripts/keeper.ts` — the headless Keeper entry the scheduled task runs;
  `PI_FREEBUFF_KEEPER_JSON` config, log to `keeper.log` in the repo root.
- `scripts/register-keeper-task.ps1` — registers the daily 21:00 Task
  Scheduler entry (bun + `scripts\keeper.ts`); `-Unregister` removes it,
  `-WhatIf` dry-runs.
- `skills/freebuff/SKILL.md` — the bundled skill the host loads on demand.
- `tests/` — unit tests per module, corpus tests over the recorded screen
  fixtures, the host-seam policy guard, stub end-to-end tests over
  `tests/helpers/stub-freebuff.mjs`, and the SDK harness tier that drives the
  extension factory in a real agent session (`tests/helpers/sdkHarness.ts`);
  the gated live modules over the real CLI (`tests/live.test.ts`,
  `tests/liveCapture.test.ts`) share the rig in `tests/helpers/live.ts`; the
  runner config env (`PI_FREEBUFF_RUNNER_JSON`) is what points a run at a
  real plugin directory instead of a test rig.

## Pointers

- [CONTEXT.md](CONTEXT.md) is the single domain reference — the glossary and
  the prototype vocabulary this repo inherits; this README deliberately does
  not duplicate it.
- [docs/adr/](docs/adr/) records the decisions: ADR-0001 one turn-scoped Lock
  in one shared Workspace; ADR-0002 the Keeper stays a scheduled script;
  ADR-0003 three endings — cancel, detach, abandon; ADR-0004 Task state is
  process-scoped; ADR-0005 the repo checkout is the extension package; ADR-0006
  the run tool returns at the Ack.
