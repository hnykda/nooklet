# Code review follow-through, 2026-09-13 — M7 server/sync findings (rv-server-sync)

Brief from the M8 coordinator: fix ten code-review findings on the server and sync write paths
(F1–F10), each already confirmed by an independent skeptic. Reproduce each one first with a
failing test, fix the cause, one commit per finding, high severity first; write this record last.

Branch `m8/rv-server-sync`, from `da85cfb`. Bugs were written to
`docs/bugs-inbox/rv-server-sync.md` (not `docs/BUGS.md`, which a dozen branches would conflict on);
progress in `docs/progress/rv-server-sync.md`.

## Scope

Read in full for this work: `packages/server/src/{apply-ops,verify,gc,ref-reindex,data-api}.ts`
(the parts named below), `ops/{block-to-page,block-move-to-page,page-merge,batch-undo,
trash-restore,trash-list,dry-run,trial-lock,resolve,registry}.ts`, `sync/push.ts`,
`plugins/before-write.ts`, `assets/store.ts` (its audit rows); `packages/core/src/sync/apply-ops.ts`,
`core/src/query.ts` (`termSql`, `queryNeedsProperties`, `matchQuery`), `core/src/refs.ts`
(`extractRefs`); ADR 003 and 022; sql-schema.md rules 24 and 26; mcp-tools.md §4.3.17, 25–27, 30.
The web client was read only where it consumes what changed (`sync/sync-client.ts` applies
`corrections`; `data/queries.ts` runs the prefilter).

The reviewer's probes (`P1`–`P11`) import from the main checkout, so they were used as evidence
only; every finding got a real test in this branch.

## Findings, by severity

Line numbers are at `da85cfb`.

| # | Sev | Where | What | Bug | Outcome |
|---|---|---|---|---|---|
| F1 | high | `packages/server/src/data-api.ts:254` (`subtreePlaceOps`), `apply-ops.ts:112` | A device's later-HLC `block.place` that moves a block back onto its old page wins LWW over the server's cross-page move; the children stay on the new page under a parent on the old one — on neither page, not in the trash, `verify` clean. | B-120 | fixed `b913148` |
| F2 | medium | `packages/server/src/data-api.ts:267` (`siblingRows` filter) | A tombstoned descendant stays on the old page when its parent moves; `trash.restore` brings it back onto neither page. | B-120 | fixed `6e1281f` |
| F3 | medium | `packages/server/src/ops/block-to-page.ts:124`, `block-move-to-page.ts:128`, `page-merge.ts:169` | The three refactor ops commit, then throw on a rejected op; on an ordinary page named like an ISO date `block.to_page` loses the continuation lines and answers 400. | B-122 | fixed `05e0145` |
| F4 | medium | `packages/server/src/ops/batch-undo.ts:158`, `trash-restore.ts:21-24` | After B-90, `batch.undo` and `trash.restore` report success when the page un-delete is rejected and the block un-deletes apply. | B-90 (existing) | fixed `a6cd161` |
| F5 | medium | `packages/server/src/verify.ts:76` | `verify` replays rejected ops in HLC order; a late push that lost a name collision shows as divergence. | B-123 | fixed `79c1b70` |
| F6 | low | `packages/server/src/ref-reindex.ts:24` | The B-86 migration rebuilds `ref` only; `path_ref` (backlinks) stays keyed on `target|label`. | B-86 (existing) | fixed `668c0d3` |
| F7 | low | `packages/core/src/query.ts:1052` | The query `ref` prefilter drops blocks whose only reference is in `alias::` or another property. | B-124 | fixed `b035d86` |
| F8 | low | `packages/server/src/apply-ops.ts:349` | `recordChanges` does `results.find` per op — quadratic in a batch. | note under B-85 | fixed `33b4797`, and the real cause `df6b6fc` |
| F9 | low | `packages/server/src/data-api.ts:454,459,555` | `DataApi` deletes stamp `Date.now()` per op, so a plugin delete restores partially. | B-121 | fixed `0f404cc` |
| F10 | low | `packages/server/src/gc.ts:189` | Asset GC ignores references held only by page history, which "restore this version" brings back. | B-91 (existing) | fixed `5a8a440` (policy flagged) |

All ten reproduced. None was left as "does not reproduce".

Numbering: this branch had B-120..B-124. F1 and F2 share B-120 (one mechanism, one fix), F4/F6/F10
are follow-ups under their original entries, and F8 plus the slowness it led to are a note under
B-85 because the range ran out. The coordinator may want to give that note its own number.

### Found while fixing

| Where | What | Outcome |
|---|---|---|
| `apply-ops.ts#subtreeIds` / `reindexTouchedEntities` | The reindex walk queried `WHERE parent_id = ?` with no `deleted_at` filter, which the partial `block_children` index cannot serve: one full table scan per visited block, and every touched block re-walked its whole subtree. Moving the owner's 961-block subtree took 23 s at `da85cfb`; a 16,000-op batch 8.2 s. This, not F8's `find`, was most of F8's measured time. | fixed `df6b6fc` (note under B-85) |
| `ops/resolve.ts#resolvePageRef` step 1 | An ordinary page named like an ISO date (`pages/2026-09-07.md` imported) is unreachable by that name over the wire: `page.read {page: "2026-09-07"}` → 404, `page.append` → **500** `journal: failed to read back created page` (the journal create is rejected as a key collision). Probed in a throwaway test, not fixed: the refactor ops now resolve it (F3), the read/append door is `resolve.ts` + `DataApi.pages.journal`. | logged under B-122, open |
| `packages/server/src/verify.ts#keyOf` | Joins primary-key parts with a literal NUL byte, so git and `grep` treat the file as binary (diffs show `Bin`). Harmless at runtime. | left alone, recorded |
| `docs/bugs-inbox/rv-server-sync.md` | The renumbering rewrite in `6e1281f` silently dropped the B-91 entry; restored in `5a8a440`. | fixed |

## Pass 2 — changes

In order; each commit green on `pnpm exec biome check`, `pnpm -r typecheck`, and the unit suites of
the packages it touched.

1. `b913148` fix(server): children follow their parent's page whoever moved it (B-120) — a second
   repair pass in `serverApplyOps`, next to the cycle correction (`subtree-page-repair.ts`): every
   descendant of a block that changed page, sitting on a different page than its parent, gets a
   server-HLC `block.place` keeping parent and order, minted parent-first, applied in the same
   transaction, logged, recorded in `changes` (so `batch.undo` of the move reverses it) and returned
   as `corrections` (the web client already applies those). sql-schema.md rule 24 updated.
2. `6e1281f` fix(core,server): tombstoned descendants move with their parent (B-120, F2) — the walk
   includes tombstoned children; core's `resolvePlace` keeps a tombstoned parent **when it is the
   parent the block already has** (a tombstone hides a subtree, it does not dissolve it —
   research/03-sync.md), so a deleted grandchild stays attached; a move under a *different* deleted
   parent still falls back. The walk is limited to blocks whose applied `block.place` names a page
   other than their pre-batch page, which also covers a batch that moves a block away and back.
3. `05e0145` fix(ops): to_page, move_to_page and merge write all or nothing (B-122) —
   `ops/apply-all-or-nothing.ts` (savepoint, rolled back before the error); `resolveOrMintPage`
   returns a live page already stored under the key it would mint.
4. `a6cd161` fix(ops): batch.undo and trash.restore fail loudly on a rejected un-delete (B-90) —
   `batch.undo` checks name clashes first (`conflict`, `details.live_page_id`); `trash.restore`
   refuses `new_name` on a journal day; both apply all or nothing. mcp-tools.md errors updated.
5. `79c1b70` fix(verify): do not replay ops the server rejected (B-123) — `loadOps` skips
   `status = 'rejected'`; the report counts them. sql-schema.md rule 26 updated.
6. `668c0d3` fix(server): the [[Target|label]] re-index rebuilds path_ref too (B-86) — rebuild via
   `reindexBlockAndSubtree`, candidates from `ref` or `path_ref`, new done-flag key so a graph that
   ran the first version runs again.
7. `b035d86` fix(core): the query ref prefilter admits references held in properties (B-124).
8. `33b4797` perf(server): recordChanges looks results up in a Map (F8).
9. `df6b6fc` perf(server): reindex walks children through the index, once per batch (F8) —
   `block-children.ts#childLookup` (live children via the index, tombstoned ones from one scan);
   refs first, then `path_ref` once for the union of touched subtrees. Shared by the repair pass
   and the B-86 re-index.
10. `0f404cc` fix(data-api): a delete is one instant, so the trash restores all of it (B-121).
11. `5a8a440` fix(gc): an asset page history still references is not an orphan (B-91) — ADR 022 §5
    amended.

### Tests that would have caught them

| Finding | Test (all fail on `da85cfb`, verified by running them before the fix or against the reverted code) |
|---|---|
| F1 | `packages/server/src/subtree-page-repair.test.ts` — "a later device reorder on the old page wins, and the subtree comes back with it"; "a device moving a child to another page brings the grandchildren along"; "a batch that moves a block away and back does not strand what was placed under it meanwhile" |
| F2 | same file — "a deleted child follows a cross-page move and restores onto the parent's page, grandchild attached"; "page.merge carries a deleted child along too, so restoring it lands on the target"; `packages/core/src/sync/apply-ops.test.ts` "block.place keeps a tombstoned parent it already has (B-120)" (3) |
| F3 | `packages/server/src/ops/refactor-atomicity.test.ts` — "block.to_page onto an ordinary page named like a date extends that page", and "… writes nothing when any op of its batch is rejected" for each op (rejection injected with a `beforeWrite` hook; `op` and `changes` row counts asserted unchanged) |
| F4 | `packages/server/src/ops/undelete-collision.http.test.ts` (2); the guard: `refactor-atomicity.test.ts` "batch.undo / trash.restore writes nothing when core rejects any op of it" |
| F5 | `packages/server/src/verify-rejected.test.ts` (2; HLC order pinned with `hlc.receive`, not a sleep) |
| F6 | `packages/server/src/ref-reindex.test.ts` — "rebuilds path_ref too, …", "runs again on a graph whose first re-index fixed ref but left path_ref stale" |
| F7 | `packages/core/src/query-prefilter-refs.test.ts` |
| F8 (reindex walk) | `packages/server/src/block-children.test.ts` — an `EXPLAIN QUERY PLAN` assertion that the child query uses `block_children` |
| F8 (`find`) | none — see below |
| F9 | `packages/server/src/data-api-delete-instant.test.ts` (2, `Date.now` advancing 1 ms per call) |
| F10 | `packages/server/src/gc.test.ts` — "keeps an asset that only page history still references, …", "does not count an asset's own upload audit row as a reference" |

### Verification

- **Unit suites at `5a8a440`** (`pnpm -r test`): core 336, plugin-api 17, server 544, web 684 —
  **1,581 passed, 0 failed**. During the work, individual full runs hit 5 s timeouts under load
  average 20–40 (core `sync.property.test.ts` and the `tokens.test.ts` "stays far away from
  quadratic" timing test, `plugins/host.test.ts`, `plugins/built-ins.test.ts`, web
  `render-seams.test.tsx`); each passed on an immediate rerun, and the property test passed three
  more runs with a 60 s timeout after the `resolvePlace` change.
- **`pnpm -r typecheck`**: clean at every commit.
- **`pnpm nooklet verify`** on a fresh backup of the owner's graph (952 pages, 18,628 blocks,
  20,411 ops): OK after F1, F2 (the core reducer change), F5 and the reindex walk.
- **Real-data probes** (kept in `tools/probes/`):
  - `subtree-page-repair-real-graph.ts` — the graph's largest subtree (961 blocks) with a 6-block
    tombstoned child, moved to another page and back by device ops: 961/961 on the destination,
    0 page/parent mismatches after each move, `verify` clean. The graph had 0 mismatched rows
    before, so no migration is needed for it.
  - `reindex-parity-real-graph.ts` — every `ref` (2,185) and `path_ref` (32,671) row rebuilt through
    the new walk is identical to what the old walk had built.
  - `apply-ops-batch-scaling.ts` — 16,000 `block.text` ops in one batch: 8.2 s at `da85cfb`, 7.7 s
    after the Map, 1.8 s after the walk (8,000: 1.0 s — linear). The 961-block server-planned move:
    23 s → 0.46 s. Load averages 5–24 on a shared machine; the ratios are the point.
  - Query prefilter on the graph: the new clause admits exactly the 55 blocks (84 page/tag `ref`
    rows) the old one dropped; no live block with a non-`Task` `ref` row is excluded any more.
- **e2e** (`NOOKLET_E2E_PORT=6470`, chromium, real server, production build): `trash`, `refactor`,
  `history`, `remote-device` — 18/18; `editing`, `query`, `references`, `context-menu`,
  `selection` — 49 passed, 1 skipped (`context-menu.spec.ts:200` "Delete appears for a selected
  block and deletes it", a pre-existing `test.fixme`). Run once each, no reruns needed.

## Pass 3 — left alone, and why

- **F8's `find` has no unit test.** A timing assertion is noise on this machine (the repo's one
  timing test flaked twice during this work). Believed fixed; measured by
  `tools/probes/apply-ops-batch-scaling.ts`. The real cause (the walk) has a deterministic test.
- **An ordinary page named like an ISO date is unreachable by name** (`page.read` 404,
  `page.append` 500). Found while fixing F3, same root cause as its trigger, logged under B-122.
  The fix belongs in `resolve.ts#resolvePageRef` step 1 and `DataApi.pages.journal`, which several
  ops share; out of this brief's scope.
- **A laptop's offline journal day loses to an agent's `page_append`, and the laptop's typed blocks
  are rejected** (`no-such-page`) rather than re-homed onto the surviving day. F5 made `verify`
  stop reporting it; the data question itself is sql-schema.md open issue 2 (a sync-protocol
  decision), recorded under B-123.
- **Graphs other than the owner's may already hold orphans from before B-120** (children whose
  page differs from their parent's, from the B-85 window or from device moves). The repair pass
  heals a subtree the next time its root moves; nothing sweeps existing rows. The owner's graph has
  none (`SELECT … WHERE c.page_id != p.page_id` → 0).
- **F10 is a policy, and the conservative side was chosen.** Keeping history-referenced assets
  means, with `changes` never trimmed, that GC no longer collects an image edited out of its block.
  ADR 022 §5 now records the trade and the two rejected alternatives (grace from the last history
  mention; document the limitation and keep collecting). The owner may prefer the other side.
- **`verify.ts`'s NUL separator** — harmless, would churn a file other branches may touch.

### Still unverified

- **Client-side convergence of the repair ops was not driven end to end.** The web client applies
  `corrections` from a push and the ops arrive by pull like any other (`sync-client.ts`), and the
  push test asserts the corrections' entities; but no test runs two real replicas through a
  concurrent cross-page move and compares their state. `sync/round-trip.test.ts` is where one
  would go.
- **The `resolvePlace` change's replay determinism is argued, not proven.** It adds a dependence on
  the block's current parent at apply time. Server arrival order and HLC-ordered replay can differ
  only when a place op for the same block arrives late with an older HLC and a tombstoned parent is
  involved; the existing rule (a parent's `deleted_at`) has the same class of window. The property
  tests (3 extra runs) and `verify` on 20,411 real ops found nothing; neither generates that
  interleaving on purpose.
- **Noop ops are still replayed by `verify`.** A `block.place` that was `no-such-block` at the
  server (its create arrived later with an older HLC) would apply on replay. Not observed, not
  probed; noted so the next false divergence has a suspect.
- **The repair pass's cost on a push of many cross-page moves** was measured only for one large
  subtree (≈1 s including the repair, at load ~20); a push of hundreds of independent cross-page
  moves was not timed.
- **The new error answers were not seen in the UI.** The web trash view never sends `new_name`
  (`data/history.ts#restoreFromTrash`), so the journal-day refusal cannot reach it; `batch.undo`'s
  new `conflict` and the all-or-nothing `invalid` reach the History view, which catches errors into
  a `role="alert"` line (`HistoryView.tsx`) — read in the code, not provoked in a browser: no e2e
  spec creates a name clash before an undo.
