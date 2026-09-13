# rv-merge-server — fixing the server/core merge review findings

Branch `m9/rv-merge-server`, from `cf08d19`. Worktree
`<repo>/.claude/worktrees/wf_e473942f-106-13`. Brief: four confirmed findings (F1–F4)
from the review of the M8 merge resolutions in server/core and the cherry-picks. Reproduce each with
a failing test, fix the cause, one commit per finding, high severity first. Then write
`docs/review/2026-09-13-rv-merge-server.md` and commit it last.

Bugs go to `docs/bugs-inbox/rv-merge-server.md` (not `docs/BUGS.md`). New numbers: B-365..B-369.

The reviewer's probes live in the session scratch dir
(`…/scratchpad/m9/rv-merge-server/*.probe.test.ts`); they import from the main checkout, so they are
evidence, not tests. Every finding gets a real test in the repo.

## Number map

| Finding | Severity | Bug | Status |
|---|---|---|---|
| F1 live mirror never retries a failed page (B-126 x B-260) | medium | B-365 | fixed 2677236 |
| F2 batch.undo name pre-check ignores keep_later_edits | low | B-366 | fixed (F2 commit) |
| F3 batch.undo name pre-check ignores aliases (B-256) | low | B-367 | todo |
| F4 core pageMirrorPath lacks NAME_MAX shortening | low | B-368 | todo |

## Done

- F1 / B-365 — `2677236`:
  `mirror/live.ts` carries `failed` page ids into the next sweep via `exportAll`'s new
  `alsoPageIds` (`mirror/export.ts`); cursor still advances. Test `mirror/live.test.ts` "retries a
  page it could not write on the next sweep… (B-365)" failed before (second sweep logged nothing).
  Server suite 609/609, typecheck clean.

- F2 / B-366 — fix(ops) commit "batch.undo checks the name the page will have after the undo":
  `ops/batch-undo.ts` `pagePlan(row)` (name/tombstone after the undo, whether a rename is written)
  feeds both the pre-check and the op builder; `laterEdits` memoized per entity. The reviewer's
  suggested fix alone was not enough: the undo still wrote `page.rename` to the page's own name on a
  page that stays trashed, and core rejects it when a live page holds the key (409 -> 400). That
  rename is no longer written. Tests: `batch-undo-later-edits.http.test.ts` "…(B-366)" (409 at
  base), `undelete-collision.http.test.ts` "batch.undo of a restore under new_name…(B-366)" (400 at
  base). mcp-tools.md §4.3.17 errors updated. Server 611/611, typecheck clean, verify OK on
  real-graph copy (20,411 ops; untouched copy, so only a smoke check).

## In flight

- F3: alias check in `batch.undo`'s pre-check, reusing `pagePlan`.

## Next steps

1. F1 (medium), then F2, F3 (both `ops/batch-undo.ts`; F3 builds on F2's "name after the undo"),
   then F4 (core `pageMirrorPath` + server `pageFilePath` delegate).
2. Review doc `docs/review/2026-09-13-rv-merge-server.md`, committed last.

## How to resume

`git log --oneline cf08d19..m9/rv-merge-server` shows what landed; the table above says which
finding is next. Before each commit: `pnpm exec biome check --write <files>`, `pnpm -r typecheck`,
unit tests of touched packages.
