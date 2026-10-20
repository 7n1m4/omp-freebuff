---
status: accepted (2026-10-18)
---

# ADR-0002: The streak Keeper stays a scheduled script in this repo

The login streak needs one small freebuff run on days OMP is never opened, and the extension exists only while an OMP session does — so the Keeper stays the Windows Scheduled Task and drives freebuff itself through the ported modules: spawn in the Workspace, submit one small read-only Task, wait for turn end, shut down only the Instance it started. It reads the **shared** chat store for the current allowance window, so an OMP session's work already counts as the day's activity and the Keeper usually exits without spawning; it obeys ADR-0001's Lock with `kind: 'keeper'`, waiting while a Turn runs and reclaiming an idle holder. Resolved by [pi-freebuff#5](https://github.com/vadash/pi-freebuff/issues/5). Retiring it loses the streak; folding it into the extension leaves the days OMP is closed uncovered; a second repo over-fits a thin consumer of modules that live here — and as the protocol's second implementer it is what keeps the Lock honest. Since the 2026-10-20 cutover the `Freebuff Streak Keeper` task runs this repo's `scripts/keeper.ts`; a day OMP is open and used needs no Keeper action.
