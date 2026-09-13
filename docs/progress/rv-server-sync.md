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
| F1 children orphaned when a later device place wins over a server cross-page move | high | B-120 | fixed (commit: see Done) |
| F2 deleted descendants left behind by a cross-page move; restore → invisible | medium | B-121 | logged |
| F3 to_page / move_to_page / merge commit, then throw | medium | B-122 | logged |
| F4 batch.undo / trash.restore report success on a rejected un-delete | medium | B-90 (existing) | logged |
| F5 verify replays rejected ops | medium | B-123 | logged |
| F6 B-86 migration leaves path_ref stale | low | B-86 (existing) | logged |
| F7 query `ref` prefilter drops property-only refs | low | B-124 | logged |
| F8 recordChanges O(n²) | low | none (range exhausted; review doc only) | logged |
| F9 DataApi deletes: one timestamp per op | low | B-121 (same family: restore brings back less than was deleted) | logged |
| F10 asset GC ignores history snapshots | low | B-91 (existing, a second hole of the same kind) | logged |

## Done

- F1 / B-120: `packages/server/src/subtree-page-repair.ts` + hookup in `apply-ops.ts`; tests
  `subtree-page-repair.test.ts` (3, all fail without the pass). Server suite 524/524 (4 plugin
  tests timed out at load 43 in the full run, passed on rerun). Real-graph copy: 0 page/parent
  mismatches, verify OK over 20,411 ops.

## In flight

F2 (deleted descendants follow too; core `resolvePlace` must keep a tombstoned parent for a
tombstoned child, or deleted grandchildren lose their parent).

## Next steps, in order

F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, then the review doc.

## How to resume

`git log --oneline da85cfb..` on the branch shows what landed; the table above says which
finding each commit closed. Checks per commit: `pnpm exec biome check --write <files>`,
`pnpm -r typecheck`, `pnpm --filter @nooklet/server test`, `pnpm --filter @nooklet/core test`.
After ops/sync/schema changes: `pnpm nooklet verify --data <scratch>/graph` on a fresh backup of
the real graph (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`).
