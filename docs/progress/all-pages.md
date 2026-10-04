# B-645 — All pages: block/word columns, sorting, row delete

Branch: `worktree-agent-a37ff5178c4da625f` (fast-forwarded to main `ae90be5` first). e2e port 6425,
real-graph server 6426. Status: **built, verified** (see Verification). Not merged to main.

## What Logseq has (read from source, 2026-10-04)

Logseq 0.10.9, `src/main/frontend/components/page.cljs`
(https://raw.githubusercontent.com/logseq/logseq/0.10.9/src/main/frontend/components/page.cljs),
`all-pages` / `sortable-title` / `batch-delete-dialog`:

- columns: a select checkbox, name, backlinks, created-at, updated-at; the three after name are
  hidden on mobile; every column but the checkbox sorts through `sortable-title`
- default sort `(rum/local :block/updated-at ::sort-by-item)` with `(rum/local true ::desc?)`
- bulk select + "delete" opens `batch-delete-dialog`, a confirm listing the selected pages
- toggles: include journals, include whiteboards; a "remove orphaned pages" action
  (`model/get-orphaned-pages`) through the same batch-delete confirm
- pagination, 40 per page

## What nooklet does now

Columns **Name, Blocks, Words, Created, Edited**, each header a sort toggle (first click: name
A→Z, numbers/dates biggest-newest first; a second click flips; ties fall back to name). Default
stays "Edited, newest first", as in Logseq. Row actions: the existing star, and a **Delete** button
(hover-revealed on a pointer device, always shown on touch, absent on journal rows).

- Counts: `apps/web/src/data/page-stats.ts` — one `SELECT page_id, content FROM block WHERE
  deleted_at IS NULL` on the local replica, tallied in JS; `usePageStats()` in `store.ts` refetches
  when any block changes. No server call, so offline and local-only both work.
- Word rule: moved into `plugins/word-count/src/count.ts` (`countWords`, whitespace runs over raw
  text — sane, cheap, markup not stripped) and imported by BOTH the plugin's server half and the
  app, so the numbers agree by construction. The e2e test checks the column against the plugin's
  `page.wordcount` op.
- Delete: `deletePageWithConfirm` (`app/page-delete.ts`) with the same deps as the title row
  (`findPageToDelete`, `previewPageDelete` dry run, `confirmDialog`, `deletePage`, `announce`) —
  only `navigate` is a no-op, so you stay on the list. ADR 024's referenced-page sentence comes from
  that flow unchanged. The view now shows `pageActionNotice` so a failure is visible here too.
- Width: the grid collapses by the VIEW's width (container queries, so an open sidebar counts):
  ≥36rem everything; <36rem drops Created; <28rem (phone) keeps name + Blocks + delete and shows a
  sort `<select>` (all five sorts) in place of the hidden headers.

### Deliberately left out

- **Backlinks column**: the `ref`/`path_ref` index is server-only (`data/local-ref-pages.ts` doc);
  a client count would mean re-parsing every block's links, and its number would differ from the
  linked-references heading's rule (`docs/progress/refs-count.md`). Not worth it for a column.
- **Bulk select + delete, "remove orphaned pages"**: the owner asked for delete with confirm; a
  batch path would need its own confirm wording and a multi-page server op or N dry runs. Logged
  for the owner to ask for, not built.
- **Pagination**: 1,211 rows (journals on) render in ~100 ms; not needed.
- Whiteboards toggle: nooklet has no whiteboards.

## Verification (2026-10-04)

- Real graph: `~/notes-graph` rsync'd to the scratchpad (never written in
  place), `pnpm nooklet import` into a scratch data dir: 1,211 pages (386 non-journal in the
  default view), 18,633 live blocks, 2.9 MB of text.
- `tools/probes/page-stats-tally-cost.ts` (node:sqlite): query 11.7 ms + tally 21.0 ms, medians of 7.
- `tools/probes/all-pages-columns-real-graph.mjs`, production build + `nooklet serve` on 6426,
  Chromium, 5 runs, medians: `goto /pages` → counts painted **278 ms**; sort by words **46 ms**;
  `page.append` over the API → that page's word count updated on screen **207 ms** (includes the
  sync pull); Journals on (1,211 rows) **100 ms**.
- Screenshots of desktop (1280) and iPhone 13 on the real graph looked right after one fix (date
  column widened from 6rem so "May 30, 2026" does not elide; name centred in its touch-height box).
- Tests: `apps/web/src/data/page-stats.test.ts`, `apps/web/src/views/all-pages-sort.test.ts` (unit);
  `e2e/tests/all-pages.spec.ts` (columns present, sort by header + flip, agreement with
  `page.wordcount`, live update after an edit, Delete → Cancel keeps / Delete removes and stays on
  /pages, page in Trash); `e2e/tests/all-pages-phone.spec.ts` (iPhone 13: name + blocks only, menu
  sort, no horizontal overflow).
- Full `pnpm e2e` (port 6425): 741 passed, 2 skipped, 2 failed. `views.spec.ts` "All Pages sorts by
  name…" used the sort `<select>`, which is now phone-only — changed to click the Name header.
  `journal-agenda.spec.ts:182` ("finishing a task elsewhere…") failed once with other agents' suites
  running on the machine; it passed on the rerun. Rerun of views, journal-agenda, all-pages(+phone),
  navigation, page-delete, page-icons: 58 passed.
- `pnpm --filter @nooklet/web test` 1534 passed (177 files); `pnpm -r typecheck` clean;
  `pnpm exec biome check . --diagnostic-level=error` clean; server `built-ins.test.ts` 12 passed.

## BUGS.md updates to fold in

B-645: **Status:** fixed · **Test:** `e2e/tests/all-pages.spec.ts`, `e2e/tests/all-pages-phone.spec.ts`,
`apps/web/src/data/page-stats.test.ts`. Fix note: All pages has sortable Blocks / Words / Created /
Edited columns counted on the local replica (word rule shared with the word-count plugin via
`plugins/word-count/src/count.ts`), and a per-row Delete through `deletePageWithConfirm` + the
in-app confirm (stays on the list). Collapses to name + blocks + a sort menu at phone width. Left
out on purpose: backlinks column, bulk/orphan delete, pagination (`docs/progress/all-pages.md`).
Real graph: counts painted 278 ms after navigation, refresh after an edit 207 ms.

Possible new entry (owner's call, not a bug): bulk select + delete / "remove orphaned pages" on All
pages, as Logseq has.
