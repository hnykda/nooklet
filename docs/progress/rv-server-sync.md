# rv-server-sync — fixing the M7 server/sync review findings

Branch `m8/rv-server-sync`, from `61279a2`. Worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-23`. Brief: ten confirmed findings
(F1–F10, server/core correctness) from the M7 server/sync review; reproduce each with a failing
test, fix the cause, one commit per finding, high severity first. Then write
`docs/review/2026-09-13-m7-rv-server-sync.md` and commit it last.

Bugs go to `docs/bugs-inbox/rv-server-sync.md` (not `docs/BUGS.md`). New numbers: B-120..B-124.

The review's original probes live in the session scratch dir
(`…/scratchpad/rv-server-sync/probes/*.test.ts`); they import from the main checkout, so they are
evidence, not tests. Every finding gets a real test in the repo.

Note: the worktree was created at an old commit (`f7c9644`, 88 commits behind); the branch was
re-pointed at `61279a2` before any work, as the brief requires.

## Number map

| Finding | Severity | Bug | Status |
|---|---|---|---|
| F1 children orphaned when a later device place wins over a server cross-page move | high | B-120 | fixed 351f497 |
| F2 deleted descendants left behind by a cross-page move; restore → invisible | medium | B-120 (same mechanism) | fixed cf5386d |
| F3 to_page / move_to_page / merge commit, then throw | medium | B-122 | fixed 8470f5f |
| F4 batch.undo / trash.restore report success on a rejected un-delete | medium | B-90 (existing) | fixed f6ce1fb |
| F5 verify replays rejected ops | medium | B-123 | fixed bac8cac |
| F6 B-86 migration leaves path_ref stale | low | B-86 (existing) | fixed 26171ad |
| F7 query `ref` prefilter drops property-only refs | low | B-124 | fixed f61c907 |
| F8 recordChanges O(n²) | low | note under B-85 (existing) | fixed 1f6f2c9; no unit test, probe |
| F9 DataApi deletes: one timestamp per op | low | B-121 | fixed e6e279c |
| F10 asset GC ignores history snapshots | low | B-91 (existing) | fixed cc20d87; policy flagged |
| (found) cross-page move of a big subtree takes ~23 s: reindex walks unindexed | — | note under B-85 (existing) | fixed adeab5c |

## Done

- F1 / B-120 — `351f497`: `packages/server/src/subtree-page-repair.ts` + hookup in `apply-ops.ts`;
  tests `subtree-page-repair.test.ts` (3, all fail without the pass).
- F2 / B-120 — `cf5386d`: the walk includes tombstoned descendants (live via the partial
  `block_children` index, tombstoned from one scan — a per-parent unfiltered query was 6.4 s of
  full scans on a 961-block real subtree); walks only blocks that changed page in the batch; core
  `resolvePlace` keeps a tombstoned parent the block already has. Tests: 2 more in
  `subtree-page-repair.test.ts`, 3 in core `apply-ops.test.ts`. Probe
  `tools/probes/subtree-page-repair-real-graph.ts` on a real-graph copy: 961-block subtree away and
  back, 0 mismatches, verify ok. Suites: core 335, server 526, web 684 — all pass (flaky timeouts
  under load 20–40 rerun green: core property test, tokens quadratic timing, plugin host, web
  render-seams). `verify` on the real graph copy OK (20,411 ops).
- F3 / B-122 — `8470f5f`: `ops/apply-all-or-nothing.ts` (savepoint + rollback before throwing)
  used by `block.to_page`, `block.move_to_page`, `page.merge`; `resolveOrMintPage` returns a live
  page already stored under the would-be key. Tests `ops/refactor-atomicity.test.ts` (4, all fail
  before). Server suite 530/530.
- F4 / B-90 follow-up — `f6ce1fb`: `batch.undo` pre-checks page-name clashes (conflict) and
  applies all-or-nothing; `trash.restore` refuses `new_name` on a journal day and applies
  all-or-nothing. Tests `ops/undelete-collision.http.test.ts` (2) + 2 guard tests in
  `ops/refactor-atomicity.test.ts`; all four fail before.
- F5 / B-123 — `bac8cac`: `verify.ts#loadOps` skips `status = 'rejected'`; report gains
  `rejectedSkipped`. Tests `verify-rejected.test.ts` (2, fail before with 3 and 4 divergences).
  Note: `verify.ts` holds a literal NUL byte (the key separator in `keyOf`), so diff tools treat
  it as binary — pre-existing, left alone.
- F6 / B-86 follow-up — `26171ad`: `ref-reindex.ts` rebuilds `ref` + subtree `path_ref` via the
  now-exported `reindexBlockAndSubtree`, finds candidates in both tables, new done-flag key so
  graphs that ran v1 re-run. Tests: 2 new in `ref-reindex.test.ts`.
- F7 / B-124 — `f61c907`: `core/query.ts#termSql` `ref` clause covers `alias` and `#`/`[[` in
  any property value. Test `core/src/query-prefilter-refs.test.ts`. Real graph: +55 blocks, 0 gaps.
- F8 — `1f6f2c9`: `recordChanges` uses a Map. Probe `tools/probes/apply-ops-batch-scaling.ts`
  (16k ops: find 1,364 ms vs Map 2 ms; serverApplyOps 8.2 s → 7.7 s). Still quadratic: the reindex
  walk (`subtreeIds`, unindexed `parent_id = ?`).
- F8 second half — `adeab5c`: `block-children.ts#childLookup` (index for live children, one scan
  for tombstones) shared by the reindex walk, the subtree repair and the B-86 re-index;
  `reindexTouchedEntities` rebuilds refs first, then path_ref once for the union of subtrees. Test
  `block-children.test.ts` (EXPLAIN QUERY PLAN). Probe `tools/probes/reindex-parity-real-graph.ts`:
  identical ref (2,185) and path_ref (32,671) rows on the real graph. 16k batch 7.7 s → 1.8 s; 961
  subtree move 23 s → 0.46 s. Server 540/540; verify OK.
- F9 / B-121 — `e6e279c`: one `now` per `DataApi.pages.delete` / `blocks.delete`. Tests
  `data-api-delete-instant.test.ts` (2, fail before).
- F10 / B-91 follow-up — `cc20d87`: asset GC keeps assets referenced by page/block images in
  `changes` (`keptByHistoryOnly`); ADR 022 §5 amended with the cost (GC now collects only uploads
  no write referenced) and the rejected alternatives. Policy decision flagged for the owner.
  (The B-91 inbox entry had been dropped by the renumbering rewrite in cf5386d; restored there.)
- e2e (`NOOKLET_E2E_PORT=6470`, chromium): trash, refactor, history, remote-device 18/18; editing,
  query, references, context-menu, selection 49 passed + 1 pre-existing fixme skipped.
- `pnpm -r test` at cc20d87: core 336, plugin-api 17, server 544, web 684 — 1,581 passed.
- Found in passing, logged under B-122 (open): an ordinary page named like an ISO date is
  unreachable by name (`page.read` 404, `page.append` 500).
- Review record `docs/review/2026-09-13-m7-rv-server-sync.md` — the last commit.

## In flight

Nothing. All ten findings are committed; the review record is the final commit.

## Next steps, in order

For the coordinator, not this branch: merge `docs/bugs-inbox/rv-server-sync.md` into `docs/BUGS.md`
(consider giving the B-85 note its own number); decide the ADR 022 §5 asset policy (F10); the
date-named-page reachability bug under B-122 is open.

## How to resume

`git log --oneline 61279a2..` on the branch shows what landed; the table above says which
finding each commit closed. Checks per commit: `pnpm exec biome check --write <files>`,
`pnpm -r typecheck`, `pnpm --filter @nooklet/server test`, `pnpm --filter @nooklet/core test`.
After ops/sync/schema changes: `pnpm nooklet verify --data <scratch>/graph` on a fresh backup of
the real graph (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`).
