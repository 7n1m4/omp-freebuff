---
status: accepted (2026-10-20)
---

# ADR-0007: The directory-line guard is dropped

The prototype spawned freebuff with a per-session working directory, so a wrong-directory read was a live failure mode and the footer's directory line was the only observable that caught it; the port runs freebuff in one fixed machine-wide Workspace with the Target junctioned at `<workspace>/repo`, so the footer names the Workspace on every frame whatever repo the session is in — the wrong-directory read is structurally unreachable. No directory-line guard: the line is not parsed, no `dir_mismatch` failure reason exists, and the screen-oracle list shrinks by one (identity, the settle dance, reuse-readiness, the mid-submit Ack half, the freeze key's second signal, the drift dump, the raw diagnostic). The port's real wrong-target failure mode is a stale or mis-pointed junction, invisible on the screen — `freebuff_status`'s junction target is the guard. Resolved by the full-spec review against [pi-freebuff#14](https://github.com/vadash/pi-freebuff/issues/14); amends the spec's screen-oracle list and retires the prototype's `dir_mismatch` with the other retired markers. A freebuff build that stops showing the directory line changes nothing; one that showed a *different* directory is caught by status, not by the screen.
