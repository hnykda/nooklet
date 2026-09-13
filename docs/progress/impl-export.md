# impl-export — page portability and favourites

Resume file for the M8 `impl-export` agent (branch `m8/impl-export`, worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-27`, e2e port 6408). Brief: exposure
audit §2 (`docs/review/2026-09-12-exposure-audit.md`) items 9 (copy/export page as markdown),
10 (print / Save as PDF) and 13 (favourite from the page and the palette; sidebar "Recent").
Bugs go to `docs/bugs-inbox/impl-export.md` (numbers B-220..B-229), never `docs/BUGS.md`.

## Done (committed)

- nothing yet

## In flight

- Logged B-220 (no copy/export as markdown), B-221 (print prints the chrome, drops collapsed
  children), B-222 (favourite only from /pages; sidebar "Pages" is the recent list).

## Plan / next steps, in order

1. core: move the mirror's page renderer (`server/src/mirror/export.ts#renderPageToOutline`'s
   row -> `ParsedPage` build) into `packages/core/src/page-outline.ts` as the four SQL strings
   plus a pure `buildPageOutline(rows)`; server keeps `renderPageToOutline` as a thin wrapper.
   Core unit test; server export tests must stay green.
2. web: `data/page-markdown.ts` — run the same four queries against the replica (`queryAs`),
   `buildPageOutline` + `serializeOutline` -> mirror text; file name = mirror basename.
3. web: `commands/registrations/page-actions.ts` (`app.copyPageMarkdown`,
   `app.exportPageMarkdown`, `app.printPage`, `app.toggleFavorite`) + `PageActionsHost` + fake;
   real host `app/page-actions-host.ts`; hookups in `registrations/index.ts` and `CommandLayer.tsx`.
4. web: title-row controls `views/PageActions.tsx` (star + "…" menu), one-line hookup in
   `PageView.tsx`.
5. web: `styles/print.css` (@media print) + `app/print.ts` (beforeprint/afterprint signal that
   expands collapsed children; one-line hookup in `BlockTree.tsx`'s rows memo).
6. web: sidebar "Pages" -> "Recent".
7. e2e `e2e/tests/page-export.spec.ts` (download bytes == mirror file on disk; copy; print media;
   favourite from title row and palette; sidebar Recent).
8. spec rows in `docs/spec/commands-and-keymap.md` E.6.

## Decisions

- Commands use the `app.` area: R2's core areas are a closed set and `page.` throws at boot
  (B-87 precedent, `edit.mergePage`).
- Client-side render rather than a server op: the replica has the same four tables (core schema)
  and the renderer becomes shared code, so Export works offline and includes unpushed edits.
- Copy = the same renderer with `ids: "none"` (a paste target outside nooklet has no use for
  `^id` suffixes); Export = exactly the mirror bytes, ids included.

## How to resume

- `git log --oneline da85cfb..m8/impl-export`, then this file's "Next steps".
- e2e: `cd e2e && NOOKLET_E2E_PORT=6408 pnpm exec playwright test page-export.spec.ts --project=chromium`
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-export/`
