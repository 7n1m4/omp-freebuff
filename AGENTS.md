# pi-freebuff

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `vadash/pi-freebuff` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels (label string = role name). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

- Setup: `bun install`.
- Test: `bun test` — the only runner (no vitest, no node-pty, no @xterm/headless).
- Typecheck: `bun run typecheck`.
- Install shape: `cmd /c mklink /J "%USERPROFILE%\.omp\agent\extensions\pi-freebuff" <checkout-path>`; reload = OMP restart (see ADR-0005).
- Host seam: `src/host/pty.ts` is the only module importing host internals (`@oh-my-pi/pi-natives`, `@oh-my-pi/pi-utils/vterm`); `tests/hostSeam.test.ts` enforces this.
