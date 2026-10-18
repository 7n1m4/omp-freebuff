# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Writing an ADR

Offer one only when all three hold: the decision is hard to reverse, it is surprising without context, and it was a real trade-off. A refactor that only moves code between modules fails the first two; that belongs in the commit message, not in `docs/adr/`.

Keep it to a title and one to three sentences. Add `Decision`, `Considered Options`, or `Consequences` only when a section carries something the paragraph cannot, and list only the alternatives a future reader would plausibly propose again.

Record supersession as `status: superseded by ADR-NNNN` frontmatter when the file stays. When the successor restates the decision whole, retire the file instead: delete it and move its number and title into the retired table in `docs/adr/README.md`. A retired number is spent for good, and nothing cites it except the row that records it. Numbering skips spent numbers: the next number is one past the highest ever used, file or ledger row.

The full template, retirement mechanics, and an optional shape-test pattern are in `ADR-FORMAT.md` (the domain-modeling skill).
