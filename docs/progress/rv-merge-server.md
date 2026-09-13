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
| F2 batch.undo name pre-check ignores keep_later_edits | low | B-366 | fixed d4f1335 |
| F3 batch.undo name pre-check ignores aliases (B-256) | low | B-367 | fixed (F3 commit) |
| F4 core pageMirrorPath lacks NAME_MAX shortening | low | B-368 | todo |

## Done

- F1 / B-365 — `2677236`:
  `mirror/live.ts` carries `failed` page ids into the next sweep via `exportAll`'s new
  `alsoPageIds` (`mirror/export.ts`); cursor still advances. Test `mirror/live.test.ts` "retries a
  page it could not write on the next sweep… (B-365)" failed before (second sweep logged nothing).
  Server suite 609/609, typecheck clean.

- F2 / B-366 — `d4f1335`:
  `ops/batch-undo.ts` `pagePlan(row)` (name/tombstone after the undo, whether a rename is written)
  feeds both the pre-check and the op builder; `laterEdits` memoized per entity. The reviewer's
  suggested fix alone was not enough: the undo still wrote `page.rename` to the page's own name on a
  page that stays trashed, and core rejects it when a live page holds the key (409 -> 400). That
  rename is no longer written. Tests: `batch-undo-later-edits.http.test.ts` "…(B-366)" (409 at
  base), `undelete-collision.http.test.ts` "batch.undo of a restore under new_name…(B-366)" (400 at
  base). mcp-tools.md §4.3.17 errors updated. Server 611/611, typecheck clean, verify OK on
  real-graph copy (20,411 ops; untouched copy, so only a smoke check).

- F3 / B-367 — fix(ops) commit "batch.undo refuses a name a live page uses as an alias":
  pre-check calls `trash-restore.ts#livePageAliasing` (exported; takes a list of page ids to leave
  out, via `json_each`) for pages not in the batch, and a lazily built index of the aliases the undo
  leaves each batch page. Pages that are live under the same key before and after are not checked
  (moves no name). New `ops/batch-undo-alias.http.test.ts` (4; 2 failed before). Tool description +
  mcp-tools.md §4.3.17 errors. Server 615/615, typecheck clean.

## In flight

- Real-graph check of F2+F3 through a server on the graph copy, then `verify`; e2e
  `history-later-edits.spec.ts`, `trash-conflict.spec.ts` (+ other history/trash specs) on port 6471.

## Next steps

1. F4 (core `pageMirrorPath` + server `pageFilePath` delegate; web page-export).
2. Review doc `docs/review/2026-09-13-rv-merge-server.md`, committed last.

## How to resume

`git log --oneline cf08d19..m9/rv-merge-server` shows what landed; the table above says which
finding is next. Before each commit: `pnpm exec biome check --write <files>`, `pnpm -r typecheck`,
unit tests of touched packages.
