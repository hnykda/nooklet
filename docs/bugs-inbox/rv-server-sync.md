# Bugs inbox — rv-server-sync (M8)

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on it. Source: the
M7 server/sync code review (findings F1–F10, each confirmed by an independent skeptic), fixed on
branch `m8/rv-server-sync`. Record: `docs/review/2026-09-13-m7-rv-server-sync.md`.

Numbering: this branch had B-120..B-124. F1 and F2 share B-120 (one mechanism, one fix); F4, F6
and F10 are follow-ups to B-90, B-86 and B-91; F8 and a slowness found in passing are notes under
B-85 (existing), since the range ran out.

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
**Status:** open · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F9) ·
**Test:** —

`DataApi.pages.delete` and `DataApi.blocks.delete` (what plugins reach through `ctx.data`) call
`Date.now()` for every op they mint. `trash.restore` brings back a page's blocks — and a block's
descendants — only when their `deleted_at` equals the root's, which is how it recognises one delete
action. A plugin delete that spans a millisecond therefore restores a page with no blocks; the
blocks become separate trash entries. Probe: `Date.now` advancing 1 ms per call,
`api.pages.delete` on a 3-block page, then `trash.restore` → 1 entity restored, page empty.
`ops/page-delete.ts` and `ops/block-delete.ts` already take one `now`.

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
**Status:** open · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F7) ·
**Test:** —

The SQL prefilter for a `ref` term (`core/query.ts#termSql`) passes only blocks with `#` or `[[`
in the content, or a `tags` property. `extractRefs` — which `matchQuery` and backlinks use — also
reads `alias::` and every other property value. So `date-saved:: [[Sep 7th, 2026]]` on a block with
plain content shows in the day's backlinks but never in `ref:"2026-09-07"`; the prefilter breaks
its own promise to return a superset. Probe: `related:: [[Foo]]` and `alias:: Foo` blocks match in
JS, prefilter returns neither. The owner's graph has 55 live blocks whose only references are in
properties (`date-saved`, `date-published`).

---

### B-85 (existing)

Big batches stall the server (F8, plus one found in passing while measuring B-120):

- **`recordChanges` looked each op's result up with `results.find`**, once per op — quadratic in
  the batch. `graph.replace` allows 20,000 blocks in one `applyOps`; a big `page.merge` or sync
  push is one batch too. The skeptic measured the `find` alone at about 0.25 s at 8k ops and 1.1 s
  at 20k.
- **Open, not fixed here:** a cross-page move of a large subtree is slow on the code as it stands,
  before this branch. Moving the owner's largest subtree (961 blocks) with `subtreePlaceOps`
  through `serverApplyOps` took 23 s at `da85cfb` (load average ~24 on a shared machine).
  `reindexTouchedEntities` calls `reindexBlockAndSubtree` for every placed block, which walks that
  block's whole subtree with `SELECT id FROM block WHERE parent_id = ?` — no `deleted_at` filter,
  so the partial `block_children` index cannot serve it and every step is a full scan — and
  rebuilds `path_ref` for each descendant: roughly subtree² full scans. Fix direction: collect the
  union of touched subtrees once per batch (live children via the index, tombstoned ones from one
  scan, as `subtree-page-repair.ts#childLookup` does), then rebuild each block's `path_ref` once.
