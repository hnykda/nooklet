# rv-server-sync — fixing the M7 server/sync review findings

Branch `m8/rv-server-sync`, from `da85cfb`. Worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-23`. Brief: ten confirmed findings
(F1–F10, server/core correctness) from the M7 server/sync review; reproduce each with a failing
test, fix the cause, one commit per finding, high severity first. Then write
`docs/review/2026-09-13-m7-rv-server-sync.md` and commit it last.

Bugs go to `docs/bugs-inbox/rv-server-sync.md` (not `docs/BUGS.md`). New numbers: B-120..B-124.

The review's original probes live in the session scratch dir
(`…/scratchpad/rv-server-sync/probes/*.test.ts`); they import from the main checkout, so they are
evidence, not tests. Every finding gets a real test in the repo.

Note: the worktree was created at an old commit (`41666ee`, 88 commits behind); the branch was
re-pointed at `da85cfb` before any work, as the brief requires.

## Number map

| Finding | Severity | Bug | Status |
|---|---|---|---|
| F1 children orphaned when a later device place wins over a server cross-page move | high | B-120 | fixed b913148 |
| F2 deleted descendants left behind by a cross-page move; restore → invisible | medium | B-120 (same mechanism) | fixed 6e1281f |
| F3 to_page / move_to_page / merge commit, then throw | medium | B-122 | fixed 05e0145 |
| F4 batch.undo / trash.restore report success on a rejected un-delete | medium | B-90 (existing) | fixed a6cd161 |
| F5 verify replays rejected ops | medium | B-123 | fixed 79c1b70 |
| F6 B-86 migration leaves path_ref stale | low | B-86 (existing) | fixed (see Done) |
| F7 query `ref` prefilter drops property-only refs | low | B-124 | logged |
| F8 recordChanges O(n²) | low | note under B-85 (existing) | logged |
| F9 DataApi deletes: one timestamp per op | low | B-121 | logged |
| F10 asset GC ignores history snapshots | low | B-91 (existing) | logged |
| (found) cross-page move of a big subtree takes ~23 s: reindex walks unindexed | — | note under B-85 (existing), not fixed | logged |

## Done

- F1 / B-120 — `b913148`: `packages/server/src/subtree-page-repair.ts` + hookup in `apply-ops.ts`;
  tests `subtree-page-repair.test.ts` (3, all fail without the pass).
- F2 / B-120 — `6e1281f`: the walk includes tombstoned descendants (live via the partial
  `block_children` index, tombstoned from one scan — a per-parent unfiltered query was 6.4 s of
  full scans on a 961-block real subtree); walks only blocks that changed page in the batch; core
  `resolvePlace` keeps a tombstoned parent the block already has. Tests: 2 more in
  `subtree-page-repair.test.ts`, 3 in core `apply-ops.test.ts`. Probe
  `tools/probes/subtree-page-repair-real-graph.ts` on a real-graph copy: 961-block subtree away and
  back, 0 mismatches, verify ok. Suites: core 335, server 526, web 684 — all pass (flaky timeouts
  under load 20–40 rerun green: core property test, tokens quadratic timing, plugin host, web
  render-seams). `verify` on the real graph copy OK (20,411 ops).
- F3 / B-122 — `05e0145`: `ops/apply-all-or-nothing.ts` (savepoint + rollback before throwing)
  used by `block.to_page`, `block.move_to_page`, `page.merge`; `resolveOrMintPage` returns a live
  page already stored under the would-be key. Tests `ops/refactor-atomicity.test.ts` (4, all fail
  before). Server suite 530/530.
- F4 / B-90 follow-up — `a6cd161`: `batch.undo` pre-checks page-name clashes (conflict) and
  applies all-or-nothing; `trash.restore` refuses `new_name` on a journal day and applies
  all-or-nothing. Tests `ops/undelete-collision.http.test.ts` (2) + 2 guard tests in
  `ops/refactor-atomicity.test.ts`; all four fail before.
- F5 / B-123 — `79c1b70`: `verify.ts#loadOps` skips `status = 'rejected'`; report gains
  `rejectedSkipped`. Tests `verify-rejected.test.ts` (2, fail before with 3 and 4 divergences).
  Note: `verify.ts` holds a literal NUL byte (the key separator in `keyOf`), so diff tools treat
  it as binary — pre-existing, left alone.
- F6 / B-86 follow-up — (this commit): `ref-reindex.ts` rebuilds `ref` + subtree `path_ref` via the
  now-exported `reindexBlockAndSubtree`, finds candidates in both tables, new done-flag key so
  graphs that ran v1 re-run. Tests: 2 new in `ref-reindex.test.ts`.

## Next steps, in order

F7, F8, F9, F10, then the review doc.

## How to resume

`git log --oneline da85cfb..` on the branch shows what landed; the table above says which
finding each commit closed. Checks per commit: `pnpm exec biome check --write <files>`,
`pnpm -r typecheck`, `pnpm --filter @nooklet/server test`, `pnpm --filter @nooklet/core test`.
After ops/sync/schema changes: `pnpm nooklet verify --data <scratch>/graph` on a fresh backup of
the real graph (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`).
