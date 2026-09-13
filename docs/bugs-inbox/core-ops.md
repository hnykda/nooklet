# Bug inbox — core-ops (M10)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-390..B-399.

---

### B-310 (existing)

**Fixed 2026-09-13.** Two halves, one cause each, both in `packages/core/src/outline.ts`:

- Parser: line 1's fence was looked for on the raw line, marker still attached, so `- TODO ```js`
  never opened one. `firstLineOpensFence` now strips marker/priority first (`splitTaskHead`, shared
  with `finalizeNode`), in both places line 1 is read (block-level fence tracking and the
  property/content split).
- Serializer: OUT-14's form wrote `- ^id` and dropped the head. It now writes `- TODO [#A] ^id`,
  and the parser reads a line 1 left empty by head/id, followed by a line opening a fence, as not
  a content line. Without ids and with properties: after the closed fence (as B-151), or — fence
  never closes — `- TODO` alone on line 1 before the properties.

Spec: `docs/spec/markdown-grammar.md` OUT-14 rewritten, OUT-18's B-151 paragraph updated. Tests:
`packages/core/src/outline.test.ts` › "a task block that opens with a fence (B-310)" (5; 4 fail on
the old code), `packages/server/src/mirror/export.test.ts` › "reads back empty blocks, a
fence-first task and a blank-line-first task as written" (fails on the old code). Probe
`tools/probes/fence-first-task-roundtrip.ts` now prints the block back unchanged in both modes.
Not verified: how Logseq itself reads `- TODO ```js` in a file (no Logseq here); the owner's graph
has no such block.

---

### B-390 · An empty block's mirror line `- ^id` reads back as the text `^id` with no id — 441 of 952 mirror files
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, core-ops (fixing B-310) ·
**Test:** `packages/core/src/outline.test.ts` › "a block whose line 1 is only its id (B-390)" (3),
`packages/server/src/mirror/export.test.ts` › "reads back empty blocks, a fence-first task and a
blank-line-first task as written"

The serializer writes a block whose line 1 is empty as `- ^id` (or `- TODO ^id`), but the parser
only took a lone `^id` when another line followed (OUT-14's fence form), and OUT-12's ` ^id`
suffix regex needs the space that stripping a marker also removes. So on re-read:

- every empty block (`- ^id`) came back with content `"^1k7…"` and no id;
- a task with an empty line 1 (`- LATER ^id` + `  > text`) came back with content `"^id\n> text"`
  and no id — the owner has one (`1m287mdbgs5v8t`);
- `- ^id\n  text` (content `"\ntext"`, no marker) lost its leading empty line.

Measured on a copy of the owner's graph with `tools/probes/mirror-roundtrip-graph.ts` (renders
each page exactly as `mirror/export.ts` does and parses it back): before the fix 441 of 952 pages
read back differently — 578 blocks with a wrong id and 598 with wrong content. After: 2 pages, 20
blocks, all the known pre-B-266 literal `SCHEDULED: <…>` lines (content moves into
`scheduled::`). Nothing reads the mirror back in normal operation, which is why it went unseen; it
bites on "walk away with the files" re-import, and — by reading `outline-bridge.ts`, not run — on
`page.append`/`block.insert` markdown holding a `- ^id` line: a new block with the text `^id`
instead of mcp-tools.md rule 6's upsert of that existing block.

Fix (`outline.ts#finalizeNode`): a line 1 that is exactly `^id` after marker/priority stripping
carries the id whether or not more lines follow; its now-empty line 1 is dropped only when the
next content line opens a fence (OUT-14), else kept as the content's own empty line. An empty
block with a `^id` is no longer taken for a page-properties pre-block (`parseOutline` tracks which
ids came from `^` syntax) — otherwise a page whose first block is empty would lose that block into
`page.properties.id`. Spec: OUT-14. Known remaining ambiguity: a block whose whole content is the
text `^<valid id>`, written without ids (`ids: "none"`), reads back as an empty block with that id.

---

### B-322 (existing)

**Fixed 2026-09-13.** `ops/page-backlinks.ts`, not-yet-created-page branch: the linked-reference
query and the unlinked-mention exclusion now key by `refKeyOf(input.target)` — the key refs are
indexed under — instead of `normalizePageName(input.target)`; the tagged-pages lookup shares the
same key. `target: "Sep 20th, 2026"` and `"20.09.2026"` now return the same linked references as
`"2026-09-20"`, and a block linking the day is no longer also listed as an unlinked mention of it.
Test: `packages/server/src/ops/page-backlinks-missing-journal.http.test.ts` (2; both fail on the
old code — "expected +0 to be 2", and the linking block in `unlinked`).

---

### B-370 (existing)

**Fixed 2026-09-13.** `ops/batch-undo.ts` now orders the restore by page names before minting any
op: a page whose ops claim a key (a rename back, or an un-delete) goes after the page of the same
batch that holds that key now and gives it up (a page the batch created, deleted by the undo; or a
page renamed away or sent back to the trash). Blocks keep batch order. Undoing "rename A to B +
create a new A" and undoing that undo both answer 200; so does a chain (A to Archive, Draft to A).
Two pages swapping names form a cycle no order solves: still 400 `page-key-collision`, nothing
written — pinned by a test so a later change sees it. Test:
`packages/server/src/ops/batch-undo-name-order.http.test.ts` (3; the first two fail on the old
code with 400).
