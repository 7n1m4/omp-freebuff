---
status: accepted (2026-10-20)
---

# ADR-0008: A bounded Wait tool until extensions can register jobs

The host's native wait wakes only on registered jobs, peers and services, and an extension cannot register a job today, so a Task is invisible to it — the boring available answer is a bounded blocking Wait exposed to the Owner session, returning at the Task's Verdict or at its bound, with Esc detaching a working Task exactly as without a Wait (ADR-0003). When the host lets extensions register Tasks as native async jobs, the built-in wait covers Tasks and the extension's Wait tool is disabled.
