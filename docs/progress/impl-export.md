# impl-export — page portability and favourites

Resume file for the M8 `impl-export` agent (branch `m8/impl-export`, worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-27`, e2e port 6408). Brief: exposure
audit §2 (`docs/review/2026-09-12-exposure-audit.md`) items 9 (copy/export page as markdown),
10 (print / Save as PDF) and 13 (favourite from the page and the palette; sidebar "Recent").
Bugs go to `docs/bugs-inbox/impl-export.md` (numbers B-220..B-229), never `docs/BUGS.md`.

Note: the worktree was created at an old commit (`41666ee`); the branch was reset to `da85cfb`
before any work, as the brief says everyone starts there.

## Done (committed)

- `6b8d703` progress file + B-220..B-222 logged.
- `06ed234` core: the mirror's renderer moved to `packages/core/src/sync/page-outline.ts`
  (`PAGE_OUTLINE_SQL`, `buildPageOutline`, `readPageOutline`, `pageMirrorPath`); server
  `mirror/export.ts` wraps it. B-223 fixed (siblings tie-break by id). Core 338 / server 521 green.
- (this commit) web: page actions — see "What exists" below. B-220, B-221, B-222 fixed; B-224,
  B-225 logged open.

## What exists (web)

- `apps/web/src/data/page-export.ts` — `renderPageMarkdown(pageId, {ids})` from the replica,
  `findPageIdByName`, `isFavoriteValue`, `isPageFavorite`.
- `apps/web/src/app/page-actions.ts` — clipboard (promised `ClipboardItem`, WebKit gesture rule),
  download, favourite toggle, the title-row notice signal. `app/print.ts` — `beforeprint` signal +
  `printPage`; imports `styles/print.css`.
- `apps/web/src/commands/registrations/page-actions.ts` — `app.copyPageMarkdown`,
  `app.exportPageMarkdown`, `app.printPage`, `app.toggleFavorite`; `args.page` or the route.
  Real host `app/page-actions-host.ts`. Hookups: `registrations/index.ts` (dep + spread),
  `CommandLayer.tsx` (one line).
- `apps/web/src/views/PageActions.tsx` + `page-actions.css` — star + "…" menu, running the
  commands through `useCommands().buildContext(...).exec`. Hookup: one line in `PageView.tsx`.
- `editor/tree.ts#flattenVisible` `expandAll`; `BlockTree.tsx` rows memo passes `isPrinting()`.
- `shell/Sidebar.tsx` "Pages" -> "Recent"; `pages.spec.ts` / `page-icons.spec.ts` locate the
  section by its h2 now.
- `e2e/tests/page-export.spec.ts` — 7 tests (export == mirror file on disk, copy incl. unpushed
  edit, palette export, print via real `page.pdf()`, palette print, star, palette favourite +
  Recent heading).

## In flight

- `views.spec.ts` "opening the palette while editing and closing it hands focus back to the
  editor" fails on this branch, 3 of 3 runs (once in the batch, once in the spec, once alone). It
  still fails with PageActions, the page-actions commands and the print hookup all removed, so it
  looks pre-existing; confirming against a `da85cfb` build is the next step.

## Next steps, in order

1. Confirm the views.spec focus failure on a `da85cfb` build (check out `apps/web` and
   `packages/core` from `da85cfb` into the working tree, run that one test, restore from HEAD).
   If pre-existing: log it as B-226 (open) with the evidence; not this branch's to fix.
2. Spec rows for the four commands in `docs/spec/commands-and-keymap.md` E.6.
3. Real-graph check: serve a copy of the owner's graph on a spare port, export a heavy page from
   the browser and byte-compare with the mirror file serve writes; `pnpm nooklet verify` on the
   copy.
4. Final e2e run of the specs touched + at risk; report.

## Decisions

- Commands use the `app.` area: R2's core areas are a closed set and `page.` throws at boot
  (B-87 precedent, `edit.mergePage`).
- Client-side render rather than a server op: the replica has the same four tables (core schema)
  and the renderer is now shared code, so Export works offline and includes unpushed edits.
- Copy = the same renderer with `ids: "none"`; Export = exactly the mirror bytes, ids included.
- Title-row controls run the registered commands (one path, MRU, reachable by agents via ui_run).
- Off a page route the page commands do nothing (as `edit.mergePage`); Print prints any view.
- The star is always visible (not hover-revealed) — discoverability was the complaint.
- Print expands collapsed blocks only between `beforeprint`/`afterprint`; nothing is written.

## How to resume

- `git log --oneline da85cfb..m8/impl-export`, then this file's "Next steps".
- e2e: `cd e2e && NOOKLET_E2E_PORT=6408 pnpm exec playwright test page-export.spec.ts --project=chromium`
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-export/`
  (real graph copy in `graph/`, screenshots/PDFs from the visual check).
