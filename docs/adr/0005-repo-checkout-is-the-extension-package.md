---
status: accepted (2026-10-19)
---

# ADR-0005: The repo checkout is the extension package

The extension loads from the live checkout, no build step: the repo root is the package and `package.json#omp.extensions` declares the entry (`["./src/index.ts"]`) — the field is authoritative, the loader never scans the repo, so tests, probes and `node_modules` stay out of the extension graph. Registration is `omp plugin link <checkout-path>` for development or `omp plugin install github:vadash/pi-freebuff` for a copied install; a hand-made junction into `~/.omp/agent/extensions/` plus an `extensions:` config entry stays a working equivalent. Reloading means restarting OMP — there is no hot reload, and the `?mtime` cache-buster is ignored on Windows. Resolved by [pi-freebuff#15](https://github.com/vadash/pi-freebuff/issues/15). A copied build makes two sources of truth; convention-based scan loading drags the test tree into the graph. Deleting the checkout breaks the load.
