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

---

### B-324 (existing)

**Fixed 2026-09-13.** A Tasks view row now shows the scheduled date and the deadline, each
labelled ("Scheduled 2032-04-01", "Deadline 2032-04-20 14:30", with the time when there is one),
both when both are set, stacked in the row's date column — `views/taskFilters.ts#taskDateLabels`,
rendered by `views/TasksView.tsx` (`.task-due .task-date`), styled in `styles/views.css`. Tests:
`apps/web/src/views/taskFilters.test.ts` › "taskDateLabels" (2) and
`e2e/tests/tasks-view-dates.spec.ts` (1, Chromium, port 6401: both labels on a scheduled task with
a deadline, a lone deadline with its time, a lone scheduled date, none for an undated task, and the
row found by its deadline in a Due window still labelled). Not checked at phone width by a test.

---

### B-311 (existing)

**Fixed 2026-09-13.** `apps/web/src/editor/paste.ts#pastedBlocks`: when the pasted text parses with
page properties (lines before the first bullet, or a first bullet of nothing but property lines),
they become an empty first block carrying them as its properties, inserted with the rest — not
dropped. The pre-block's `id::` is not carried (a page id; paste mints new ids anyway). Text that
is nothing but property lines now creates that one block (before, no block at all, and an empty
target was still deleted with focus sent to id ""). Tests: `apps/web/src/editor/paste.test.ts` ›
"property lines the parser reads as a page-properties pre-block (B-311)" (4; 3 fail on the old
code) and `e2e/tests/paste-page-properties.spec.ts` (1, Chromium, port 6401: a real paste event
into a production build; the stored tree has the property block between the anchor and the pasted
bullets).

---

### B-391 · `page.append`, `block.insert` and `page.create` report `updated: []` when their markdown upserts existing blocks
**Status:** open · **Severity:** low · **Found:** 2026-09-13, core-ops-verify (writing the B-390
upsert test) · **Test:** none for the report; the upsert itself is
`packages/server/src/ops/outline-empty-block-id.http.test.ts`

mcp-tools.md rule 6 makes a ` ^id` in write markdown an upsert of that existing block, and
`outline-bridge.ts#prepareMarkdownInsert` returns the upserted ids as `updated` — but all three
callers destructure only `{ops, created, outline}` and answer `updated: []`
(`page-append.ts`, `block-insert.ts`, `page-create.ts`). An agent that writes back a page it read
(every block line carries `^id`) moves every block and is told "created: [], updated: []". B-390
widened the path: an empty block's `- ^id` line is now an upsert too (it used to mint a new block).
Not fixed here (a reporting change in three ops outside this branch's bugs). Likely fix: pass
`updated` through in each.

---

### Verification of this branch (core-ops-verify, 2026-09-13)

Re-run and extended by a second agent; nothing above needed a code change. Evidence, for folding:

- Every new test above fails on 70c9bb9's code where the entry says it does (B-322 2/2, B-370 2 of
  3 plus the two added below, B-311 3 of 4 re-run against the old `paste.ts`).
- Added: `packages/core/src/outline.test.ts` › "serialize -> parse is lossless across heads, ids,
  properties and content shapes" (192 blocks × both id modes × with/without page properties; fails
  on the old parser); `batch-undo-name-order.http.test.ts` › three-step rename chain, and a page
  the batch created renamed into the name another page gave up (both fail on the old
  `batch-undo.ts`); `outline-empty-block-id.http.test.ts` (on the old parser `page.append` of
  `page.read`'s `- ^id` / `- TODO ^id` lines created two blocks reading `^…`);
  `e2e/tests/fence-task-clipboard.spec.ts` (Cmd+C / paste of a fence-first task with a property
  and a child) and `e2e/tests/tasks-view-dates-phone.spec.ts` (iPhone 13: both labels stacked, no
  horizontal overflow).
- Logseq import is untouched by the B-310 parser change: old and new `parseOutline` give identical
  trees for every `.md` under the owner's `notes-graph` (952), `roam` (759), `beta` and `test`.
- Known cost, as OUT-14 now says: a content that is a blank line followed by a fence reads back
  without the blank line when the block has a head or an id (a random round-trip fuzz finds nothing
  else). Real data: 1 of 18,628 blocks has a blank line 1, and it is followed by a quote, not a
  fence; 0 blocks have content that is literally `^<id>`.
- Real graph copy (13:44), served: 8 real pages — 404 blocks, 9 of them empty (`- ^id`) and 11
  opening with a fence (OUT-14's `- ^id` + fence form) — were written into new pages through
  `page.create` with their own `page.read` text (max_chars 200,000): every block moved with
  identical id, parent, content, marker, priority, properties and collapsed, none created. `nooklet verify` OK before (20,411 ops) and after (22,900 ops). (A first attempt at
  the default `max_chars` left one 15 KB block behind: `page.read` truncates at 20,000 characters
  and says `truncated: true` — by design, not a bug.)
- Full Chromium e2e in three chunks on port 6401: 527 passed, 1 failed, 2 skipped. The failure is
  `editing.spec.ts`'s `openJournal` draft race (B-335, open); a rerun of that file failed the same
  way in a different test (load average ~110 at the time); a second rerun at load ~11 passed 4/4.
