# rv-merge-web — fix the M9 review findings on the M8 merge resolutions (web client)

Branch `m9/rv-merge-web`, worktree `.claude/worktrees/wf_e473942f-106-14`, based on `cf08d19`.
e2e port **6470**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/rv-merge-web/`
(the reviewer's probe `caret-probe.test.ts` is there; it imports from the MAIN checkout; run from
`apps/web`: `pnpm exec vitest run --root <scratch> caret-probe` — passes, 2/2, re-run 2026-09-13).

Findings F1–F5, one commit each, each reproduced by a failing test first. Bugs in
`docs/bugs-inbox/rv-merge-web.md`: B-360 (F1), B-361 (F2), B-362 (F3), B-363 (F4), B-364 (F5).
Review record: `docs/review/2026-09-13-rv-merge-web.md` (the last commit).

## Done

- Bugs logged in the inbox before any fix (first commit, `docs(bugs-inbox,progress)`).
- F1 / B-360 — `bufferCaret()` in `BlockTree.runStructural`'s same-block branch. e2e case in
  `templates.spec.ts` failed first (stored `list: "number!"`, content without the `!`), passes with
  the fix. e2e templates + template-undo + template-collapsed + block-properties: 24/24. Web unit:
  996/1000 in the full run at load average 63 (page-title, SearchView ×2, render-seams timeouts);
  those three files rerun alone: 23/23. Commit `c3bb9f7`.
- F2 / B-361 — `openPageFind` saves `contentOffsetOf(content, end)`. Unit case in
  `app/page-find.test.ts` failed first (31 for 17); e2e case in `page-find.spec.ts` failed first
  (caret 41 for 31) and passes; page-find.spec 9/9. Web unit 1001/1001.

## In flight

- F3 / B-362.

## Next steps, in order

1. (done) F1.
2. (done) F2.
3. F3: readOnly guard in `doUndo`/`doRedo` + e2e in `read-only.spec.ts`.
4. F4: `filtered` off while printing + `.page-find` hidden in print.css + e2e in
   `page-export.spec.ts`.
5. F5: header comment.
6. Review doc, last commit.

## How to resume

`git log --oneline cf08d19..` shows what landed. Before each commit: `pnpm exec biome check --write
<files>`, `pnpm -r typecheck`, `pnpm --filter @nooklet/web test`. e2e:
`cd e2e && NOOKLET_E2E_PORT=6470 pnpm exec playwright test <specs> --project=chromium`
(export `NOOKLET_DATA=<scratch>/data` first in the same shell).
