# Bugs inbox — rv-server-sync (M8)

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on it. Source: the
M7 server/sync code review (findings F1–F10, each confirmed by an independent skeptic), fixed on
branch `m8/rv-server-sync`. Record: `docs/review/2026-09-13-m7-rv-server-sync.md`.

---

### B-120 · A block moved to another page loses its children when a second device reorders it on the old page
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M7 server/sync review (F1) ·
**Test:** `packages/server/src/subtree-page-repair.test.ts` "a later device reorder on the old page
wins, and the subtree comes back with it" (plus "a device moving a child to another page brings the
grandchildren along", "a batch that moves a block away and back does not strand what was placed
under it meanwhile")

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

**Fixed 2026-09-13.** A second server repair pass in `serverApplyOps`, next to rule 24's cycle
correction (`packages/server/src/subtree-page-repair.ts`): after a batch applies, every descendant of
a block placed in that batch which sits on a different page than its parent gets a server-HLC
`block.place` keeping its parent and order and taking the parent's page, minted parent-first. They
apply in the same transaction, are logged (replay parity holds), recorded in `changes` with the
batch (so `batch.undo` of the move reverses them) and returned as `corrections` (so the pushing
device converges). The walk covers every block placed in the batch, not only those whose page
differs from the pre-image, because a batch can move a block away and back and strand what was
placed under it meanwhile. All three tests fail without the pass. The owner's graph has 0 rows whose
page differs from their parent's, so no migration; `verify` clean over 20,411 ops.

---

### B-121 · Trash restore can bring a block back onto no page, or a page back without its blocks
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F2, F9) ·
**Test:** —

Two ways the trash gives back less than was deleted:

1. **Deleted descendants stay behind on a cross-page move (F2).** `subtreePlaceOps` walks children
   with `siblingRows`, which skips tombstoned blocks. Delete `c1` under `p`, move `p` to `Dst`:
   `c1` keeps `page_id = Src` with `parent_id = p` (on `Dst`). `trash.list` still offers it (its
   page and parent are live); `trash.restore c1` answers 200 `{page: "Src"}`, and `c1` is then on
   neither page and no longer in the trash. Same for `block.move`, `block.to_page`, `page.merge`.
2. **Plugin deletes stamp one timestamp per op (F9).** `DataApi.pages.delete` and
   `DataApi.blocks.delete` call `Date.now()` for every op. `trash.restore` brings back a page's
   blocks (and a block's descendants) only when their `deleted_at` equals the root's, so a plugin
   delete that spans a millisecond restores a page with no blocks; the blocks become separate trash
   entries. Probe: `Date.now` advancing 1 ms per call, `api.pages.delete` on a 3-block page, then
   `trash.restore` → 1 entity restored, page empty.

---

### B-122 · `block.to_page`, `block.move_to_page` and `page.merge` commit their writes, then answer 400
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F3) ·
**Test:** —

`ctx.applyOps` commits immediately; these three handlers look for a rejected result only
afterwards and throw, so the caller gets an error with no `batch_id` while part of the batch has
landed. Trigger: an ordinary page named like an ISO date (`2026-09-07`, e.g. imported from
`pages/2026-09-07.md`). `resolvePageRef` sends a wire date to `pages.journal()`, which does not see
the ordinary page, so `resolveOrMintPage` mints a journal `page.create` whose key collides. The
create is rejected, the continuation-line `block.create` is rejected (no such page), the child
moves are rejected — and the `block.text` replacing the block with `[[2026-09-07]]` is applied.
Block `2026-09-07\nmore text` with a child: `block.to_page` → 400 `rejected: page-key-collision`;
the block now reads `[[2026-09-07]]` and `more text` exists nowhere. `verify` is clean.

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

---

### B-123 · `nooklet verify` reports divergence after a late push loses a page-name collision
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F5) ·
**Test:** —

`verifyRebuildParity` replays every logged op, rejected ones included, and core re-sorts by HLC.
Whether a `page.create`, `page.rename` or un-delete is rejected depends on state, so a late push
carrying an older HLC wins the name on replay although the server rejected it. Pull never ships
rejected ops, so no client sees them. Realistic case: a laptop offline since before today's journal
existed creates the day and types into it; an agent `page_append`s to today; the laptop pushes and
its `page.create` and `block.create` are rejected → `verify` reports 4 divergences. (That the
laptop's typed text is rejected at all is a separate sync-protocol question — see sql-schema.md
open issue 2.)

---

### B-86 (existing)

The one-time migration (`ref-reindex.ts#reindexPipeAliasRefs`) rebuilds `ref` only (F6).
`path_ref`, which backlinks and backlink counts read, keeps `page_key = 'target|label'` with
`page_id = NULL` for the block and its descendants, and the migration's done-flag stops it from
ever running again — so a graph indexed before the fix still omits every old `[[Target|label]]`
from `Target`'s backlinks. Probe: after resetting `ref` and `path_ref` to the pre-fix keys and
running the migration (returns 1), `page.backlinks {target: "Target"}` → `linked: []`. The owner's
graph has 0 such rows; other graphs are affected.

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

### B-91 (existing)

A second way asset GC collects an asset something still needs (F10): `referencedAssetIds` scans
current block content and property values only. `batch.undo` — the mechanism `page.history`
tells clients to restore a version with (ADR 022 §3) — rewrites block text from
`changes.before_json`. Remove an image link by editing the block (nothing goes to the trash), run
`nooklet gc` more than 7 days later: the asset row is tombstoned and the file unlinked; undoing
the edit then brings back a link to nothing, recoverable only from the pre-GC backup archive.
Found by reading the code, not probed.
