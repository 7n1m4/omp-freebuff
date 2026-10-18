---
status: accepted (2026-10-18)
---

# ADR-0001: One turn-scoped Lock in one shared Workspace

Resolved by [pi-freebuff#5](https://github.com/vadash/pi-freebuff/issues/5), the wayfinder ticket *Workspace and singleton: one directory, one freebuff Instance*. Supersedes the prototype's supervisor lock (`freebuff-mcp/src/supervisorLock.ts` and its ADR-0005): there is no daemon to lock against. Independent of the prototype's ADR numbering.

## Context

The extension runs in-process, so it owns the freebuff **Instance** itself: no daemon, no named pipe, no process outliving the session. Three other spawners still exist on the machine, and freebuff 0.2.29 refuses none of them:

- a second OMP session's extension,
- the daily streak **Keeper**,
- the user's own interactive freebuff TUI (uncoverable from here).

A spawn is neither blocked nor refused ([pi-freebuff#4](https://github.com/vadash/pi-freebuff/issues/4)): the new process claims its own `cli:<uuid>` and idles at Welcome, and the account-level collision is decided server-side at its **first message**. So the guard must live in the extension — and what it guards is not the process but the **Workspace**: one fixed directory carrying the `repo` junction, whose single mutable pointer two Instances would swap out from under each other.

Two facts shape the rest:

- **The Hour session is not keyed to the directory.** A fresh process resumes an unexpired Hour by adopting a `freebuff-live-<pid>.json` record in the freebuff config dir (`~/.config/manicode/`) whose `ownerPid` is dead and whose `tokenKey` matches the account, claiming it by atomic rename (`consumeCrashedFreebuffSession`, `cli/src/utils/freebuff-session-relaunch.ts`; verified 2026-10-18 against the public mirror, inside the 0.2.29 build window). Killing an Instance is therefore always cheap, in any directory, and the prototype's "the session is locked to the directory" rule (its ADR-0001 §Context, ADR-0003) is 0.0.19x behaviour.
- **An Instance cannot be adopted.** A PTY handle does not cross processes: an Instance another process spawned can be killed, never typed into.

## Decision

### 1. The Lock: a machine-wide record, turn-scoped

`%LOCALAPPDATA%\freebuff-plugin\lock.json`:

```json
{ "ownerPid": 12345, "instancePid": 23456, "kind": "extension", "startedAt": "2026-10-18T18:00:00.000Z" }
```

- Written by every spawner (extension or Keeper) **before any spawn**; `instancePid` is filled once the child exists.
- **Turn-scoped, not Instance-scoped**: deleted when the Task yields its result, on *every* exit path (answer, deadline, frozen, crashed, cancelled, no_answer) — one `finally`. The Instance is not bound to it: it stays alive, idle, after release, and the same session's next Task reuses it.
- **No code fingerprint.** The prototype's fingerprint answered a daemon that outlived code reloads (its ADR-0005); in-process the code dies with the session. What remains is liveness: `process.kill(pid, 0)`.
- **Stale** = `startedAt` older than 30 minutes (the 20-minute Task deadline plus spawn/settle slack), or a dead `ownerPid`. Reclaimable whatever it claims; this is the crashed-session and hard-kill path.
- freebuff's own `freebuff-live-<pid>.json` is watched, never trusted as a guard: it exists only while a slot is held, so an Instance idling at Welcome writes nothing.

### 2. Contention: wait, then reclaim

- A claimer polls the record (~100 ms) until it is free, up to its own Task deadline, then reports `busy` naming the holder. It never refuses first, and never silently takes over a running Turn.
- Free record + live `instancePid` = an **orphan instance**. The claimer **reclaims** it: `taskkill /PID <instancePid> /T /F`, delete the record, re-point the junction at its own target, spawn in the same Workspace. Nothing is lost — `/new` precedes every Task, and the Hour resumes from the config-dir record.
- The Lock is re-taken **per Task** as the in-session queue drains, so a second OMP window can interleave between queued Tasks. Holding it while the queue drains trades that fairness for one fewer respawn per handoff.
- **Yield**: an Owner whose Instance dies unexpectedly releases the Lock and does **not** respawn; the next `run_prompt` spawns. Without this rule two sessions respawn into each other forever. Freeze, deadline and crash all end in kill + release + lazy respawn, which diverges from the prototype's respawn-immediately watchdog (its ADR-0001 §7).

### 3. Session end

Kill the Instance on `session_shutdown`. OMP gives a shutdown handler 2 s (`SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS`), which `taskkill` fits; a hard kill runs no JS at all and leaves an orphan, which is the reclaim path's job. The Instance is never left running at session end: it would hold the account's slot and the Workspace with nobody able to drive it.

### 4. Workspace and junction

- **Workspace** = `%LOCALAPPDATA%\freebuff-plugin\freebuff-ws`: durable, constant, machine-wide, never session-derived. Its basename is freebuff's chat-store key (`projects\<basename>\chats\`), hence a distinctive name rather than `ws`. `%TEMP%` is *safe* now that the Hour is known not to be directory-keyed; it is rejected because the Workspace is where freebuff's per-directory state and chat history live, and cleanup surprises cost more than a temp path saves.
- **Target directory** = the OMP session's cwd resolved to its **git root** (`git rev-parse --show-toplevel`, falling back to the raw cwd when there is no work tree), so freebuff's "you started in a subdirectory of a git repo" rebind never fires and the Instance never leaves `repo/`. `assertSafeTarget` ports as-is: filesystem roots, the Workspace and its ancestors stay refused.
- **Plugin directory** `%LOCALAPPDATA%\freebuff-plugin\`: the Lock, `errors.jsonl`, screen dumps, and the Workspace.

### 5. What the extension reports

`freebuff_status` carries `lock: {state: 'self'|'free'|'held-by-other'|'stale', ownerPid?, instancePid?, kind?, startedAt?}` and `foreign: {live: [{pid, model, expiresAt}]}` — the latter read from freebuff's own `freebuff-live-*.json` records with a liveness check, so a human sees when their interactive TUI, or another OMP window, holds the account's slot. The extension never kills an Instance it did not start in this Workspace.

## Considered options

- **Per-session mutex only**: cheap, and loses to the Keeper and the second OMP window — the two spawners that exist precisely because the extension is not the only one.
- **Instance-lifetime Lock, loser refuses** (`{busy, holder}`, today's `bind`-lock shape): makes a second OMP window useless for as long as the first merely idles, which can be a whole Hour.
- **Instance-lifetime Lock, loser takes over**: identical to the chosen design, except it also kills a Turn another session is watching. Turn-scoping gets the same handoff for free, because the released Lock already marks the handoff point.
- **Delegate the guard to freebuff**: dead — 0.2.29 blocks nothing at spawn.
- **Code fingerprint in the record**: dead weight in-process (§1).
- **Workspace in `%TEMP%` with a per-pipe hashed name**: the hash keyed a pipe that no longer exists, and the temp path trades durable chat history for nothing.

## Consequences

- Cross-session contention is a *wait* up to the claimer's own deadline, then `busy`; nothing is refused outright.
- Every handoff costs one kill + respawn (seconds), and a displaced session's in-flight Turn fails as `crashed`/`instance_lost`. Accepted: `/new` precedes every Task, so no conversation is lost, and the Hour survives the kill.
- The extension must never auto-respawn on failure.
- An orphan Instance from a hard kill holds the account's slot until some claimer reclaims it. The account-level collision with the user's own TUI stays outside the Lock entirely (see the screen-protocol ticket).
- The Keeper implements the same protocol (`kind: 'keeper'`) — see ADR-0002.
