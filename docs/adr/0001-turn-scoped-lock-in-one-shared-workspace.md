---
status: accepted (2026-10-18)
---

# ADR-0001: One turn-scoped Lock in one shared Workspace

The extension owns its freebuff Instance in-process, but a second OMP window and the scheduled Keeper spawn Instances too, and freebuff 0.2.29 refuses none of them — the account-level collision is decided server-side at the first message. What two Instances would corrupt is the Workspace's `repo` junction, so the guard is a machine-wide Lock record on the Workspace, not on the process. Two facts shape it: the Hour session is not keyed to the directory (a fresh process adopts a dead-pid `freebuff-live-<pid>.json` record, so killing an Instance is always cheap), and a PTY handle does not cross processes (an Instance can be killed, never adopted). Resolved by [pi-freebuff#5](https://github.com/vadash/pi-freebuff/issues/5); supersedes the prototype's supervisor lock and its code fingerprint.

## Decision

- `%LOCALAPPDATA%\freebuff-plugin\lock.json` = `{ownerPid, instancePid, kind, startedAt}`, written before any spawn by every spawner, `instancePid` filled once the child exists. Liveness (`process.kill(pid, 0)`), never a code fingerprint.
- **Turn-scoped**: deleted when the Task yields, on every exit path, in one `finally`; the Instance stays alive, idle, and is reused by the next Task. **Stale** = `startedAt` over 30 minutes, a dead `ownerPid`, or (ADR-0004) our pid with no live Task. Reclaimable whatever it claims, lazily on the claim path, never at session start.
- Contention polls (~100 ms) until free is due, up to the claimer's deadline, then `busy` naming the holder; it never refuses first and never takes over a running Turn. A free record naming a live instance pid is an orphan: kill the pid, delete the record, re-point the junction, spawn in the same Workspace.
- **Yield**: an Owner whose Instance dies releases the Lock and never auto-respawns; without this rule two sessions respawn into each other forever.
- Session end kills the Instance (the host's 2 s shutdown handler fits the kill); a hard kill runs no JS and leaves the reclaim path.
- **Workspace** `%LOCALAPPDATA%\freebuff-plugin\freebuff-ws`: durable, constant, machine-wide, never session-derived; its basename is freebuff's chat-store key, hence a distinctive name and not `%TEMP%`. **Target** = the session cwd's git root, junctioned at `<workspace>/repo`, swapped only while no Task runs; filesystem roots, the Workspace and its ancestors are refused. **Plugin directory** holds the Lock, `errors.jsonl`, `tasks/` and the Workspace; screen dumps are the one thing outside it — `<freebuff config dir>\screen-dumps\<version>\`, because the version they are keyed by lives in that dir's `freebuff-metadata.json` (amended by CONTEXT.md).
- `freebuff_status` reports the Lock state and the foreign live holders read from freebuff's `freebuff-live-*.json` records — watched, never trusted as a guard. The extension never kills an Instance it did not start in this Workspace.

## Considered options

A per-session mutex (loses to the Keeper and the second window); an instance-lifetime Lock whose loser refuses (an idling window blocks the second for a whole Hour) or takes over (kills a Turn another session is watching); delegating the guard to freebuff (0.2.29 blocks nothing at spawn); a code fingerprint (dead weight in-process); the Workspace in `%TEMP%` (durable chat history traded for nothing).

## Consequences

Every handoff costs one kill + respawn; a displaced session's in-flight Turn fails. A hard-killed orphan holds the slot until a claimer reclaims it. The collision with the user's own TUI stays outside the Lock (the screen layer's `slot_held` path). The Keeper implements the same protocol with `kind: 'keeper'` (ADR-0002).
