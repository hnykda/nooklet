# Bugs inbox — rv-server-sync (M8)

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on it. Source: the
M7 server/sync code review (findings F1–F10, each confirmed by an independent skeptic), fixed on
branch `m8/rv-server-sync`. Record: `docs/review/2026-09-13-m7-rv-server-sync.md`.

Numbering: this branch had B-120..B-124. F1 and F2 share B-120 (one mechanism, one fix); F4, F6
and F10 are follow-ups to B-90, B-86 and B-91; F8 and the slowness found in passing while measuring
B-120 are a note under B-85 (existing), since the range ran out — the coordinator may want to give
that note its own number.

---

### B-120 · A block moved to another page loses its children when a second device reorders it on the old page
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M7 server/sync review (F1, F2) ·
**Test:** `packages/server/src/subtree-page-repair.test.ts` "a later device reorder on the old page
wins, and the subtree comes back with it" and "a deleted child follows a cross-page move and
restores onto the parent's page, grandchild attached" (plus three more there, and
`packages/core/src/sync/apply-ops.test.ts` "block.place keeps a tombstoned parent it already has
(B-120)")

Device B has page `Src` synced and reorders block `x` on `Src` (offline, or just before its next
pull). Meanwhile an agent or the menu moves `x` to `Dst` with `block.move_to_page`, which moves the
whole subtree (B-85). B's `block.place` for `x` carries the later HLC, so it wins and `x` goes back
to `Src` — but its children stay on `Dst` with `parent_id = x`. Neither page's tree query finds
them, they are not in the trash, and `verify` is clean because the op log is self-consistent.
Probe: `Src '- a / - x / - c1 / - g / - c2'`, move `x` to `Dst` (4 moved), then a later-HLC device
`block.place x {Src, null}`: applied, 0 corrections; `Src` reads `[x, a]`, `Dst` reads `[d]`.

B-85's fix lives in the op layer (`data-api.ts#subtreePlaceOps`) and so covers only moves the
server itself plans; any `block.place` arriving by sync that changes a block's page leaves the
same orphans.

The same walk also skipped **tombstoned descendants** (F2): `subtreePlaceOps` reads children
through `siblingRows`, which filters `deleted_at IS NULL`. Delete `c1` under `p`, move `p` to
`Dst`: `c1` keeps `page_id = Src` with `parent_id = p` (on `Dst`). `trash.list` still offers it
(its page and parent are live); `trash.restore c1` answers 200 `{page: "Src"}`, and `c1` is then on
neither page and no longer in the trash. Same for `block.move`, `block.to_page`, `page.merge`.

**Fixed 2026-09-13.** A second server repair pass in `serverApplyOps`, next to rule 24's cycle
correction (`packages/server/src/subtree-page-repair.ts`): for every block that changed page in
the batch (an applied `block.place` whose page differs from the block's pre-batch page — which
also catches a batch that moves a block away and back), each descendant, tombstoned ones included,
that sits on a different page than its parent gets a server-HLC `block.place` keeping its parent
and order and taking the parent's page, minted parent-first. They apply in the same transaction,
are logged (replay parity holds), recorded in `changes` with the batch (so `batch.undo` of the move
reverses them) and returned as `corrections` (so the pushing device converges). For the tombstoned
half, core's `resolvePlace` now keeps a tombstoned parent when it is the parent the block already
has (research/03-sync.md: "descendants stay attached and hidden"); without that, a deleted
grandchild's repair op fell back to the top level. A move under a *different* deleted parent still
falls back. sql-schema.md rule 24 updated. Every server test named above fails without the pass.
Real graph (copy): 0 rows whose page differs from their parent's (no migration needed); moving the
largest subtree (961 blocks, a 6-block tombstoned child) away and back with device ops leaves 0
mismatches and `verify` clean (`tools/probes/subtree-page-repair-real-graph.ts`); `verify` clean
over the owner's 20,411 ops with the new `resolvePlace`.

---

### B-121 · A page deleted by a plugin comes back from the trash without its blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F9) ·
**Test:** `packages/server/src/data-api-delete-instant.test.ts` "a page deleted through ctx.data
comes back from the trash with all its blocks" and "a subtree deleted through ctx.data comes back
whole"

`DataApi.pages.delete` and `DataApi.blocks.delete` (what plugins reach through `ctx.data`) call
`Date.now()` for every op they mint. `trash.restore` brings back a page's blocks — and a block's
descendants — only when their `deleted_at` equals the root's, which is how it recognises one delete
action. A plugin delete that spans a millisecond therefore restores a page with no blocks; the
blocks become separate trash entries. Probe: `Date.now` advancing 1 ms per call,
`api.pages.delete` on a 3-block page, then `trash.restore` → 1 entity restored, page empty.
`ops/page-delete.ts` and `ops/block-delete.ts` already take one `now`.

**Fixed 2026-09-13.** `DataApi.pages.delete` and `DataApi.blocks.delete` (both modes) take one
`now` per call and stamp it on every op. Both tests run the delete with `Date.now` advancing a
millisecond per call and fail before (1 of 4 entities restored; three trash entries instead of
one).

---

### B-122 · `block.to_page`, `block.move_to_page` and `page.merge` commit their writes, then answer 400
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F3) ·
**Test:** `packages/server/src/ops/refactor-atomicity.test.ts` "block.to_page onto an ordinary page
named like a date extends that page", and "… writes nothing when any op of its batch is rejected"
for each of the three ops

`ctx.applyOps` commits immediately; these three handlers look for a rejected result only
afterwards and throw, so the caller gets an error with no `batch_id` while part of the batch has
landed. Trigger: an ordinary page named like an ISO date (`2026-09-07`, e.g. imported from
`pages/2026-09-07.md`). `resolvePageRef` sends a wire date to `pages.journal()`, which does not see
the ordinary page, so `resolveOrMintPage` mints a journal `page.create` whose key collides. The
create is rejected, the continuation-line `block.create` is rejected (no such page), the child
moves are rejected — and the `block.text` replacing the block with `[[2026-09-07]]` is applied.
Block `2026-09-07\nmore text` with a child: `block.to_page` → 400 `rejected: page-key-collision`;
the block now reads `[[2026-09-07]]` and `more text` exists nowhere. `verify` is clean.

**Fixed 2026-09-13.** Both halves. `resolveOrMintPage` (`ops/block-move-to-page.ts`) looks for a
live page under the key the new page would be stored with, whatever its `journal_day`, before
minting a create — the ordinary `2026-09-07` page is the target. And all three handlers apply
their batch through `ops/apply-all-or-nothing.ts`: inside a savepoint, rolled back before the
`invalid` error is thrown, so a rejected op leaves nothing behind. The three rollback tests inject
the rejection with a `beforeWrite` hook that points one move at a missing page, and assert the
`op` and `changes` row counts are unchanged. All four tests fail without the fix. mcp-tools.md
§4.3.25–27 errors updated.

**Still open, found while fixing (same root cause as the trigger):** an ordinary page named like an
ISO date is unreachable by that name over the wire. `resolvePageRef` step 1 routes a wire date to
`DataApi.pages.journal`, which looks for a journal row only: `page.read {page: "2026-09-07"}` → 404,
and `page.append` → **500** `journal: failed to read back created page`, because its journal
`page.create` is rejected as a key collision. Probed with a throwaway test on this branch; not
fixed (the refactor ops now look the page up by stored key, the read/append door is
`ops/resolve.ts` and `DataApi.pages.journal`, shared by many ops). A fix would try the stored key
before minting, as `resolveOrMintPage` now does, and decide whether a date-named ordinary page
should shadow the journal day or be reported as a conflict.

---

### B-90 (existing)

After the B-90 fix, `batch.undo` and `trash.restore` report success when the page un-delete is
rejected (F4). The rejection used to be a thrown constraint error, which rolled the whole batch
back; now only the `page.delete {deletedAt: null}` is rejected while the `block.delete
{deletedAt: null}` ops in the same batch apply, and neither handler looks at rejected results.
`batch.undo` of a page delete after a new page took the name: 200 `restored page "Dup"`, the page
still deleted, its blocks un-deleted onto it. `trash.restore {new_name}` on a journal page: core
coerces the rename back to the ISO date, rename and un-delete are both rejected, blocks
un-deleted, 200. `trash-restore.ts`'s header still says core does not re-check the name.

**Fixed 2026-09-13.** `batch.undo` checks, before minting anything, that every page it would bring
back (or rename back) still has its name free, and answers `conflict` with
`details.live_page_id` otherwise. `trash.restore` refuses `new_name` for a journal day (`invalid`:
its name is its date). Both now apply through `ops/apply-all-or-nothing.ts` (B-122), so anything
core still rejects rolls the whole call back. Header and mcp-tools.md §4.3.17/§4.3.30 updated.
Tests: `packages/server/src/ops/undelete-collision.http.test.ts` "batch.undo of a page delete,
after a new page took the name, is conflict" and "trash.restore refuses new_name for a journal
day, whose name is its date" (both fail before: 200); the savepoint guard:
`packages/server/src/ops/refactor-atomicity.test.ts` "batch.undo writes nothing when core rejects
any op of it" and "trash.restore writes nothing when core rejects any op of it" (fail without it).

---

### B-123 · `nooklet verify` reports divergence after a late push loses a page-name collision
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F5) ·
**Test:** `packages/server/src/verify-rejected.test.ts` "a late un-delete that lost its page name to
a newer page is not a divergence" and "an offline laptop's journal day that lost to an agent's
page_append is not a divergence"

`verifyRebuildParity` replays every logged op, rejected ones included, and core re-sorts by HLC.
Whether a `page.create`, `page.rename` or un-delete is rejected depends on state, so a late push
carrying an older HLC wins the name on replay although the server rejected it. Pull never ships
rejected ops, so no client sees them. Realistic case: a laptop offline since before today's journal
existed creates the day and types into it; an agent `page_append`s to today; the laptop pushes and
its `page.create` and `block.create` are rejected → `verify` reports 4 divergences. (That the
laptop's typed text is rejected at all is a separate sync-protocol question — see sql-schema.md
open issue 2.)

**Fixed 2026-09-13.** `verify.ts#loadOps` replays only ops not logged `rejected`, in `seq` order;
the report counts what it left out (`rejectedSkipped`, "N rejected, not replayed" in the CLI
line). The server has already decided those ops, pull never ships them, and a cycle rejection's
effect is its own logged corrective op, so replaying them can only disagree with the server.
sql-schema.md rule 26 says so. Both tests fail before (3 and 4 divergences); they pin the HLC
order with `hlc.receive` rather than a sleep. Still open, and not this fix: the laptop's typed
block is rejected (`no-such-page`) rather than re-homed onto the surviving day.

---

### B-86 (existing)

The one-time migration (`ref-reindex.ts#reindexPipeAliasRefs`) rebuilds `ref` only (F6).
`path_ref`, which backlinks and backlink counts read, keeps `page_key = 'target|label'` with
`page_id = NULL` for the block and its descendants, and the migration's done-flag stops it from
ever running again — so a graph indexed before the fix still omits every old `[[Target|label]]`
from `Target`'s backlinks. Probe: after resetting `ref` and `path_ref` to the pre-fix keys and
running the migration (returns 1), `page.backlinks {target: "Target"}` → `linked: []`. The owner's
graph has 0 such rows; other graphs are affected.

**Fixed 2026-09-13.** The re-index rebuilds each candidate block with `reindexBlockAndSubtree`
(now exported from `apply-ops.ts`) — `ref` for the block, `path_ref` for it and every descendant —
and finds candidates through either table (a `|` in `ref.dst_page_key` or `path_ref.page_key`).
Its done-flag is a new key (`refs.pipe_alias.path_ref`), because a graph that already ran the first
version has clean `ref` rows and stale `path_ref` rows, and must run once more. Tests:
`packages/server/src/ref-reindex.test.ts` "rebuilds path_ref too, so the old links show in
backlinks again, children included" (fails on the old code: stale `path_ref` rows remain) and "runs
again on a graph whose first re-index fixed ref but left path_ref stale". The owner's graph copy:
0 rows with `|` in either table.

---

### B-124 · A query for `[[X]]` misses blocks whose only reference to X is in a property
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F7) ·
**Test:** `packages/core/src/query-prefilter-refs.test.ts` "keeps blocks whose only reference is an
alias:: item or a link in another property"

The SQL prefilter for a `ref` term (`core/query.ts#termSql`) passes only blocks with `#` or `[[`
in the content, or a `tags` property. `extractRefs` — which `matchQuery` and backlinks use — also
reads `alias::` and every other property value. So `date-saved:: [[Sep 7th, 2026]]` on a block with
plain content shows in the day's backlinks but never in `ref:"2026-09-07"`; the prefilter breaks
its own promise to return a superset. Probe: `related:: [[Foo]]` and `alias:: Foo` blocks match in
JS, prefilter returns neither. The owner's graph has 55 live blocks whose only references are in
properties (`date-saved`, `date-published`).

**Fixed 2026-09-13.** The `ref` fragment's property clause now reads the way `extractRefs` does:
a `tags` or `alias` row, or a `#`/`[[` in any property value. The test checks the prefilter is a
superset of `matchQuery` over content-only, `related:: [[Foo]]`, `alias:: Foo` and
`date-saved:: #Foo` blocks, and still excludes a block with no reference syntax; it fails before
(only the content block passed). On the owner's graph copy the new clause admits exactly the 55
blocks (84 page/tag `ref` rows) the old one dropped, and no live block with a non-`Task` `ref` row
is excluded any more. (`Task`, derived from the marker server-side, is not something `extractRefs`
sees either, so the two still agree there.)

---

### B-85 (existing)

Big batches stall the server (F8, plus one found in passing while measuring B-120):

- **`recordChanges` looked each op's result up with `results.find`**, once per op — quadratic in
  the batch. `graph.replace` allows 20,000 blocks in one `applyOps`; a big `page.merge` or sync
  push is one batch too. The skeptic measured the `find` alone at about 0.25 s at 8k ops and 1.1 s
  at 20k.
- **A cross-page move of a large subtree was slow** on the code as it stood before this branch. Moving the owner's largest subtree (961 blocks) with `subtreePlaceOps`
  through `serverApplyOps` took 23 s at `da85cfb` (load average ~24 on a shared machine).
  `reindexTouchedEntities` calls `reindexBlockAndSubtree` for every placed block, which walks that
  block's whole subtree with `SELECT id FROM block WHERE parent_id = ?` — no `deleted_at` filter,
  so the partial `block_children` index cannot serve it and every step is a full scan — and
  rebuilds `path_ref` for each descendant: roughly subtree² full scans. Fix direction: collect the
  union of touched subtrees once per batch (live children via the index, tombstoned ones from one
  scan, as `subtree-page-repair.ts#childLookup` does), then rebuild each block's `path_ref` once.

**`recordChanges` fixed 2026-09-13 (F8).** One `Map` from op id to result, built once. No unit
test — a timing assertion is not a signal on a machine shared by a dozen agents, so this is
believed fixed and measured instead: `tools/probes/apply-ops-batch-scaling.ts` times the lookup
shapes side by side — at 16,000 ops, 1,364 ms of `find` against 2 ms of `Map` — and one
`serverApplyOps` of N `block.text` ops (2k / 8k / 16k: 266 / 2,419 / 8,243 ms before, 239 / 2,256 /
7,687 ms after, load average 5–13). The batch was still quadratic after that; the remaining cost
was the reindex walk in the second bullet (every `block.text` reindexed its block's subtree through
the unindexed `parent_id = ?` query — a full scan per block).

**Reindex walk fixed 2026-09-13.** `packages/server/src/block-children.ts#childLookup` reads live
children through `block_children` and tombstoned ones from one scan per pass;
`reindexTouchedEntities` rebuilds `ref` for every touched block first and then `path_ref` once for
the union of their subtrees (it rebuilt each touched block's whole subtree, per block). The subtree
page repair (B-120) and the B-86 re-index share the lookup. Test:
`packages/server/src/block-children.test.ts` "reads live children through the block_children index,
never a table scan per parent" (an `EXPLAIN QUERY PLAN` assertion — deterministic, unlike a timing).
Equivalence on real data: `tools/probes/reindex-parity-real-graph.ts` rebuilt every `ref` and
`path_ref` row of the owner's graph copy through the new walk — 2,185 and 32,671 rows, identical
to what the old walk had built. Measured (load average ~20, i.e. against the machine, not for it):
16,000 `block.text` ops in one batch 7.7 s → 1.8 s (8,000: 1.0 s, now linear); the owner's
961-block subtree moved by the server-planned path 23 s → 0.46 s, and by a device op (with the
B-120 repair) 18.8 s → 1.0 s.

---

### B-91 (existing)

A second way asset GC collects an asset something still needs (F10): `referencedAssetIds` scans
current block content and property values only. `batch.undo` — the mechanism `page.history`
tells clients to restore a version with (ADR 022 §3) — rewrites block text from
`changes.before_json`. Remove an image link by editing the block (nothing goes to the trash), run
`nooklet gc` more than 7 days later: the asset row is tombstoned and the file unlinked; undoing
the edit then brings back a link to nothing, recoverable only from the pre-GC backup archive.
Found by reading the code, not probed.

**Fixed 2026-09-13.** `gc.ts#referencedAssetIds` also reads page/block pre- and post-images in
`changes`; an asset mentioned only there is kept and counted as `keptByHistoryOnly` (the CLI line
reports it). Asset rows' own audit entries are excluded. ADR 022 §5 amended with the cost: since
`changes` is never trimmed, an asset any recorded write ever embedded is never collected — the
GC now collects only uploads no write pointed at. That trade (restore fidelity over disk) is the
reviewer's primary suggestion and matches ADR 022's own reasoning, but it narrows what GC does;
the rejected alternatives are recorded there in case the owner prefers the other side. Tests:
`packages/server/src/gc.test.ts` "keeps an asset that only page history still references, so
restoring that version keeps its image" (fails before: the asset was an orphan) and "does not
count an asset's own upload audit row as a reference". The owner's graph copy has no `asset` rows,
so there was nothing real to measure.
