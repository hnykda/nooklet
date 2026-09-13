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

- Bugs logged in the inbox before any fix (first commit).

## In flight

- F1 / B-360: e2e case in `e2e/tests/templates.spec.ts`, then `bufferCaret` in
  `BlockTree.runStructural`'s same-block branch.

## Next steps, in order

1. F1 (medium): failing e2e, fix, commit.
2. F2: `page-find.ts` stores a content offset (unit test in `app/page-find.test.ts` + e2e in
   `page-find.spec.ts`).
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
