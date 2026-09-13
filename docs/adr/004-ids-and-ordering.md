# ADR 004: Short time-ordered ids and fractional-index ordering

Date: 2026-09-10 (revised the same day after the API/MCP research). Status: accepted.

## Decision

- Pages, blocks, and property definitions get 14-character ids in lowercase Crockford base32:
  45 bits of milliseconds since the epoch (time-ordered, sortable, good for a thousand years)
  followed by 25 random bits, with a per-process monotonic bump inside the same millisecond.
  Example: `1k7f3q9xz2hav4`.
- Block ids appear in markdown as an Obsidian-style ` ^id` suffix on the block's first line,
  both in the mirror files and in the API/MCP outline serialization.
- Logseq UUIDs (`id::` properties, `((uuid))` refs, `{{embed ((uuid))}}`) are mapped to new ids
  at import time and all references are rewritten. *(As built, 2026-09-13: the mapping lives in
  memory for the one import; there is no import table. A second import into the same data dir is
  safe but not an update: every page whose name exists is skipped with a `page-key-collision`
  warning, so nothing is duplicated and nothing changed in Logseq since arrives — verified by
  importing `docs/wiki` twice: 21 pages, 422 blocks after both runs.)*
- Device ids stay 8 hex characters (they are part of the HLC string); op ids are HLC strings.
- Sibling order is a fractional-index string (`fractional-indexing`), stored per block. No
  linked lists (Logseq's `left` pointer caused corruption bugs; Logseq DB also moved to
  fractional indexes).
- Page identity is the lowercased, NFC-normalized, whitespace-collapsed name. Namespaces are
  "/"-separated inside the name; ancestors are implied, never stored.

## Why

- A UUID costs about 20 tokens; a 14-character id costs about 5. A page read with ids on 200
  blocks drops from roughly 4,000 tokens of ids to roughly 1,000. Clear, cheap ids for LLM
  agents are a core requirement, and `^id` is a syntax Obsidian already understands.
- 25 random bits per millisecond make cross-device collisions negligible while keeping ids
  short; 18 bits (a 12-character id) was judged too tight for multi-device creation.
- Per-block independently mergeable attributes make last-writer-wins sync trivial; a linked list
  makes every reorder touch two neighbours and is unmergeable.

## Consequences

- The `core` package's `newId()` switches from UUIDv7 to this format; `isUuid` remains for
  recognizing Logseq ids during import.
- Exported files are no longer byte-compatible with Logseq's `id::` convention; they remain
  fully readable, and Obsidian block links work.

## Confirmation

User was indifferent between UUIDs and short ids on 2026-09-10; short ids kept for token
efficiency and Obsidian compatibility.
