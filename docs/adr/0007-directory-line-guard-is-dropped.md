---
status: accepted (2026-10-20)
---

# ADR-0007: The directory-line guard is dropped

Resolved by the full-spec review against [pi-freebuff#14](https://github.com/vadash/pi-freebuff/issues/14): the screen layer lists the directory-line guard among the sanctioned oracle uses, inherited from the prototype's `dir_mismatch` check (a ready/Welcome frame whose footer directory line did not name the expected directory failed the settle).

## Context

The prototype spawned freebuff with a per-session working directory, so a wrong-directory read was a live failure mode: a stale parse or a wrong `cwd` would edit the wrong repository, and the footer's directory line was the only observable that caught it.

The port has no per-session directory. The Workspace is one fixed machine-wide directory (`%LOCALAPPDATA%\freebuff-plugin\freebuff-ws`), the Target is mounted *into* it at `<workspace>/repo` through a junction, and freebuff always runs with the Workspace as its cwd. Its footer directory line therefore names the Workspace on every frame, whatever repo the session is in — the prototype's wrong-directory read is structurally unreachable. The port's real wrong-target failure mode is a stale or mis-pointed `repo` junction, and that is invisible on the screen: freebuff shows its cwd, which is the Workspace either way. That failure is caught where it lives — `freebuff_status` reports the junction's actual target, and the swap now happens only inside the claimed Lock (ADR-0001's reclaim order).

## Decision

No directory-line guard. The footer directory line is not parsed, no `dir_mismatch` failure reason exists, and the screen-oracle list shrinks by one: identity, the settle dance, reuse-readiness, the mid-submit Ack half, the freeze key's second signal, the drift dump, the raw diagnostic.

## Consequences

- A freebuff build that stops showing the directory line changes nothing; a build that showed a *different* directory would not be caught by the screen — the junction's target in `freebuff_status` is the guard for wrong-place edits.
- The spec's screen-oracle list (issue #14, Screen layer) is amended by this ADR; the prototype's `dir_mismatch` is retired with the other retired markers.
