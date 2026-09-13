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
| F1 live mirror never retries a failed page (B-126 x B-260) | medium | B-365 | fixed (F1 commit) |
| F2 batch.undo name pre-check ignores keep_later_edits | low | B-366 | todo |
| F3 batch.undo name pre-check ignores aliases (B-256) | low | B-367 | todo |
| F4 core pageMirrorPath lacks NAME_MAX shortening | low | B-368 | todo |

## Done

- F1 / B-365 — fix(server) commit "the live mirror retries a page file it could not write":
  `mirror/live.ts` carries `failed` page ids into the next sweep via `exportAll`'s new
  `alsoPageIds` (`mirror/export.ts`); cursor still advances. Test `mirror/live.test.ts` "retries a
  page it could not write on the next sweep… (B-365)" failed before (second sweep logged nothing).
  Server suite 609/609, typecheck clean.

## In flight

- F2: failing test in `packages/server/src/ops/batch-undo-later-edits.http.test.ts`.

## Next steps

1. F1 (medium), then F2, F3 (both `ops/batch-undo.ts`; F3 builds on F2's "name after the undo"),
   then F4 (core `pageMirrorPath` + server `pageFilePath` delegate).
2. Review doc `docs/review/2026-09-13-rv-merge-server.md`, committed last.

## How to resume

`git log --oneline cf08d19..m9/rv-merge-server` shows what landed; the table above says which
finding is next. Before each commit: `pnpm exec biome check --write <files>`, `pnpm -r typecheck`,
unit tests of touched packages.
