# ADR 012: The importer targets the Logseq file graph only, not the DB version's markdown export

Date: 2026-09-10. Status: superseded in scope by ADR 030 (2026-10-04): DB-version graphs are imported
too, from their mirror plus `db.sqlite`.

## Decision

nooklet's Logseq importer (M1) is built and tested against exactly one source format: the classic
Logseq file graph, where markdown files under `pages/`/`journals/` plus `logseq/config.edn` are
themselves the source of truth (`logseq/og`, in maintenance mode as of this writing). It does
**not** target the newer Logseq DB version's one-way markdown export (SQLite/Datascript is that
product's truth; the exported files are a byproduct mirror with a different directory shape,
page-level `id::` line, and no `config.edn`).

This affects only the M1 importer's directory scanning, `config.edn` parsing, and test/maintenance
commitment. It does not touch `packages/core`'s outline parser (`outline.ts`, `tokens.ts`), which
was already built to be generically liberal (tabs or spaces, `id::` or `^id`, front matter, various
property-key spellings) and, as a side effect, already round-trips both of the user's real graphs
losslessly — that tolerance is harmless and is kept, but is not a maintained import target in its
own right going forward. `docs/spec/markdown-grammar.md`'s corpus case 23 (the DB mirror's
page-level `id::` line) likewise stays as incidental, free tolerance, not a feature to extend.

## Why

The user has both kinds of graphs but asked to support only one, and judged the file-graph format
"a bit better" — consistent with nooklet's own architecture (ADR 002: markdown files are canonical,
SQLite is a derived index), which matches the classic Logseq product's philosophy directly, rather
than the DB version's "SQLite is truth, markdown is an export" philosophy. Building and testing one
importer path instead of two is meaningfully less M1 work for no loss of the graph the user
actually wants migrated.

## Consequences

- M1's importer reads `pages/`, `journals/`, `assets/`, and `logseq/config.edn` in the file-graph
  layout; it does not special-case the DB mirror's layout or its page-level id line.
- `docs/PLAN.md` and ADR 002 are updated to say "Logseq file graph" where they previously said
  "Logseq file graphs and Logseq DB markdown mirrors."
- If DB-version import is ever wanted later, it is new scope, not an extension of this ADR.
