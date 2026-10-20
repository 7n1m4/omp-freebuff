---
status: accepted (2026-10-19)
---

# ADR-0005: The repo checkout is the extension package

Resolved by [pi-freebuff#15](https://github.com/vadash/pi-freebuff/issues/15), the port's first ticket: extension skeleton, host seam, SDK harness.

## Context

The extension must load from the live checkout, so edits need no build step, while `~/.omp/agent/extensions/` is the directory OMP discovers extensions in. OMP loads extensions via `package.json#omp.extensions` (an array of paths relative to the package directory). That field is authoritative: the loader never scans the repo, and a bare file entry such as `./src/index.ts` is accepted regardless of suffix.

## Decision

The repo root is the package. `package.json#omp.extensions` declares the entry (`["./src/index.ts"]`), which keeps tests, probes and `node_modules` out of the extension graph. The checkout is registered through the plugin manager — `omp plugin link <checkout-path>` for development (a junction at `~/.omp/plugins/node_modules/<name>`), `omp plugin install github:vadash/pi-freebuff` for a copied install — which loads the same `omp.extensions` field and discovers `skills/` conventionally. A hand-made junction into `~/.omp/agent/extensions/` plus an `extensions:` config entry remains a working equivalent. Reloading means restarting OMP: there is no hot reload, and the `?mtime` cache-buster is ignored on Windows.

## Considered options

- **Copy a build into the extensions directory**: two sources of truth and stale copies.
- **Convention-based index/scan loading**: drags tests and `node_modules` into the extension graph.

## Consequences

- Deleting the checkout breaks the load.
- Registration is a one-time `omp plugin link` / `omp plugin install`.
- Every reload costs an OMP restart.
