# ADR 002: SQLite is the source of truth; markdown files are a lossless mirror

Date: 2026-09-10. Status: accepted.

## Decision

- The graph lives in SQLite: an append-only op log plus state tables (`page`, `block`,
  `block_prop`, derived `ref`, `block_fts`, `embedding`). The same schema runs on the server
  (`node:sqlite`) and in the browser client (SQLite WASM on OPFS, worker-hosted).
- Markdown files on disk are produced and consumed only by the server: one file per page in a
  Logseq-readable outline format, with `id::` on every block so the round trip is lossless.
  Import parses files into per-block ops; export renders pages on change (debounced, atomic
  write, echo suppression by content hash). Files are never the sync medium.
- Import is faithful to Logseq (tabs or spaces, continuation lines, fences, properties,
  pre-block page properties, front matter, triple-lowbar and legacy file names, journals,
  markers, priorities). Export uses our own clean, documented format that Logseq and Obsidian
  can still open. We do not chase byte-for-byte fidelity with Logseq's writer.

## Why

- Sync, the LLM API, and embeddings need per-block identity, per-field clocks, and indexes that
  plain files cannot carry. Every tool that tried to make files the coordination medium
  (SilverBullet, SiYuan, Joplin) ended up with conflict copies.
- Users still want transparent markdown (the top reason people left Logseq DB). A mirror gives
  them grep, git, and an exit path without making files the truth.
- Verified: the parser round-trips all 952 files of the user's real graph (17.5k blocks) to an
  identical tree in about 150 ms.

## Consequences

- Editing a mirrored file and the same block on a phone at the same time is last-writer-wins;
  this is documented, not "fixed".
- Empty journal pages are never materialized: a journal page exists only once it has a block.
