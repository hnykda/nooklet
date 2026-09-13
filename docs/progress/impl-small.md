# M8 progress — impl-small (audit §2 small wins)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: `docs/review/2026-09-12-exposure-audit.md` §2 table, in this order — #15 block timestamps
in the block context menu; #16 search in the current page (Cmd/Ctrl+F); #17 read-only page lock
(`read-only:: true`); #18 random page (`nav.randomPage`, journals excluded); #11 search filters in
the UI (marker, journals only / pages only) if time remains.

Branch `m8/impl-small`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-28`,
based on `da85cfb` (the worktree was created at an older commit, `41666ee`; the branch was reset to
`da85cfb` before any work). E2E port 6409. Bug entries go to `docs/bugs-inbox/impl-small.md`
(numbers B-230..B-239), never `docs/BUGS.md`.

## 1. Done (committed)

- #15 block timestamps (B-230) — commit "feat(web): block created/edited times in the context
  menu". Files: `apps/web/src/app/{block-times.ts,block-times.test.ts,BlockTimestamps.tsx,
  block-timestamps.css}`, `apps/web/src/data/block-times.ts`, one-line hookup in
  `app/BlockContextMenu.tsx`, `e2e/tests/block-timestamps.spec.ts`. Unit web 689/689; e2e
  block-timestamps + context-menu 16 passed, 1 skipped (pre-existing fixme B-73). Logged B-231
  (open) in passing.

- #15 hash `149ec79`. #16 hashes `f99479c` (feature), `45a3d0d` (perf on the 1.7 MB page),
  `a96e236` (focus-border style).
- #16 find in page (B-232) — commit "feat(web): find in page with Cmd/Ctrl+F". New:
  `app/page-find.ts` (+test), `views/PageFindBar.tsx`, `views/page-find.css`,
  `editor/pageFilter.ts` (+test), `commands/registrations/page-find.ts`,
  `e2e/tests/page-find.spec.ts`. Hookups: `BlockTree.tsx`, `BlockRowView.tsx`, `PageView.tsx`,
  `CommandLayer.tsx`, `editor-host.ts`, `commands/types.ts` (new `pageView` when-key),
  `registrations/index.ts` (+ its test literals), `editor/focus-request.ts`, spec R7/R44a.
  Unit web 707/707 (one run had a flaky `page-title.test.ts` failure that passed on rerun twice);
  e2e page-find 6/6 plus editing, focus, selection, journals, a-fresh-journal, templates,
  navigation, popups, help, context-menu, block-timestamps: 138 passed, 1 failed, 1 skipped — the
  failure is B-233, reproduced on base `da85cfb`.

- #17 read-only page lock (B-234) — commit "feat(web): read-only page lock". New:
  `editor/readOnly.ts` (+test), `editor/ReadOnlyNotice.tsx`, `editor/read-only.css`,
  `e2e/tests/read-only.spec.ts`. Hookups: `BlockTree.tsx` (reads the page property itself, so the
  journal stream is covered), `BlockRowView.tsx`, `PageView.tsx`; spec
  `markdown-grammar.md` OUT-21a. Logged B-235 (page.create markdown drops page properties) and
  B-236 (page.update refuses properties on journal days). Unit web 709/709. E2E read-only 6/6;
  with page-find, block-timestamps, context-menu, editing, selection, focus, journals, phone,
  templates, parity, navigation, shelf: 122 passed, 1 failed, 1 skipped — the failure was parity
  "the slash menu opens and inserts" (popup not visible in 5 s), which passed on rerun of
  parity.spec alone (14/14); treated as load.

- #17 hash `5cdaf21`.
- #18 random page (B-237) — commit "feat(web): nav.randomPage". New:
  `commands/registrations/random-page.ts` (+test), `data/random-page.ts` (+test via WorkerDb),
  `e2e/tests/random-page.spec.ts`; hookups in `registrations/index.ts`, `CommandLayer.tsx`; spec
  R44b. Also tightened `read-only.spec.ts`'s palette check with a positive control (a `fill` of
  ">text" does not switch the palette to commands mode; only a typed ">" does).

## 2. In flight

- #11 search filters.

## 3. Next steps, in order

1. #11 search filters (marker, journals only / pages only) in `views/SearchView.tsx`.
2. Final report: full unit suite, typecheck, e2e of every spec this branch touched.

## 4. Decisions

- `biome check` is not clean repo-wide at `da85cfb` (9 errors, 13 warnings, none in my files —
  e.g. `BlockContextMenu.tsx:134` `useSemanticElements` on `role="separator"`). My files are clean;
  I do not fix others' lint in shared files (merge conflicts).
- #15: "Edited" rather than "Updated", because `updated_at` moves only on `block.text`.
- #16: the command is gated by a NEW `WhenContext` key `pageView` (spec R7) rather than a
  hard-coded keydown listener, so it stays rebindable and palette-filtered. Coordinator: another
  branch adding a page-scoped command (favourite, print, copy as markdown) should reuse it.
- #16: filter on stored text (not rendered), diacritic-folded; ancestors shown; purely visual.
  Opening the bar calls `requestEditingEnd()` — verified necessary (Enter split the block without).
- #17: collapse stays allowed on a locked page (reading needs it); no block selection at all
  (verified necessary: a selection let Tab/Backspace/Cmd+Enter write). UI-only lock, spec OUT-21a.
- A copy of the base commit for "is it pre-existing?" e2e runs lives at `<scratch>/impl-small/base`
  (extracted from `da85cfb`, pnpm installed). Use port 6409 only when this branch is not using it.

## 5. How to resume

- `git log --oneline da85cfb..m8/impl-small` for what landed; this file for what is in flight.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-small/`.
- E2E: `cd e2e && NOOKLET_E2E_PORT=6409 pnpm exec playwright test <specs> --project=chromium`.
