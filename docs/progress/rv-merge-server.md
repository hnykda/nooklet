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
| F3 batch.undo name pre-check ignores aliases (B-256) | low | B-367 | fixed b36d2f2 |
| (found) keep_later_edits undo's outline names the before-image name | low | B-369 | fixed fee493a |
| F4 core pageMirrorPath lacks NAME_MAX shortening | low | B-368 | fixed aa866c3 |

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

- F3 / B-367 — `b36d2f2`:
  pre-check calls `trash-restore.ts#livePageAliasing` (exported; takes a list of page ids to leave
  out, via `json_each`) for pages not in the batch, and a lazily built index of the aliases the undo
  leaves each batch page. Pages that are live under the same key before and after are not checked
  (moves no name). New `ops/batch-undo-alias.http.test.ts` (4; 2 failed before). Tool description +
  mcp-tools.md §4.3.17 errors. Server 615/615, typecheck clean.

- Real graph, F2+F3: `tools/probes/undo-names-real-graph.ts` on a fresh copy — real alias
  (Taxes `alias:: daně`) refuses the undo of a "Daně" delete with 409, same as trash.restore;
  merge of "Balení" (98 linked refs) into Taxes undone -> 200, 98 links back; kept-alias variant
  409, LWW 200; kept rename (Czech name) 200 / LWW 409; kept delete 200; verify 0 divergences.
  Seen on the way: `page.delete {page: "Daně"}` while Taxes aliases "daně" deletes Taxes (alias
  resolution on a destructive op) — noted for the review doc, not a bug entry. Outline wording bug
  logged as B-369.
- e2e (port 6471): history-later-edits, history, trash-conflict, trash, mirror-live, replace,
  link-unlinked — 23 passed, 0 failed.

- Probe commit `598ce78` (tools/probes/undo-names-real-graph.ts, B-369 logged).
- F4 / B-368 — `aa866c3`:
  core `pageMirrorPath` shortens past 200 bytes (FNV-1a suffix instead of sha256, since core runs
  in the browser), new core `pageMirrorOutline` adds `title::`; server `exportPage` and web
  `renderPageMarkdown` (download only, not copy) use both; server `pageFileBase`/`pageFilePath`
  removed. Tests: core page-outline.test.ts (2 new, failed at base), server export.test.ts parity
  test, e2e page-export.spec.ts long-name test (failed at base: Chromium suggested the 345-byte
  name; mirror wrote `…~6d458ccb.md`). Unit: core 395/395, server 616/616, web 1000/1000 (first
  runs had timeouts in plugins/host, built-ins, sync.property at load average 84; green on rerun
  at ~40). typecheck clean. e2e page-export + mirror-live 13/13. Real graph copy: `nooklet export`
  952 pages, failed [], 0 shortened names, longest 114 bytes.

- B-369 — `fee493a`: summary
  line uses `pagePlan`'s `nameAfter`, `(in the trash)` when `deletedAfter`. Test in
  `batch-undo-later-edits.http.test.ts` (failed before). Server 617/617, typecheck clean.

- Final checks on the finished tree: core 395/395, server 617/617, web 1000/1000, typecheck
  clean, biome clean on all changed files; e2e (port 6471) history-later-edits, history,
  trash-conflict, trash, page-export, mirror-live, replace, link-unlinked, undo-redo,
  template-undo — 42 passed; real-graph probe rerun on a fresh copy (all as expected, outline now
  names the kept name / "(in the trash)") and `nooklet verify` OK (20,808 ops).
- Found, not fixed (no number left): `batch.undo` of one batch that renamed A to B and created a
  new A answers 400 (rename minted before the new A's delete). Scratch probe
  `undo-rename-and-recreate.probe.test.ts`. Recorded in the review doc and the inbox.
- Review doc — docs(review) commit, the last one.

## In flight

- Nothing. Branch complete.

## Next steps

1. Coordinator: fold `docs/bugs-inbox/rv-merge-server.md` into BUGS.md; number the unnumbered
   rename-and-recreate undo entry.

## How to resume

`git log --oneline cf08d19..m9/rv-merge-server` shows what landed; the table above says which
finding is next (all done as of the review doc commit). Before each commit: `pnpm exec biome check --write <files>`, `pnpm -r typecheck`,
unit tests of touched packages.
