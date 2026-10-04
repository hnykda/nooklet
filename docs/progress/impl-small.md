# M8 progress — impl-small (audit §2 small wins)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: `docs/review/2026-09-12-exposure-audit.md` §2 table, in this order — #15 block timestamps
in the block context menu; #16 search in the current page (Cmd/Ctrl+F); #17 read-only page lock
(`read-only:: true`); #18 random page (`nav.randomPage`, journals excluded); #11 search filters in
the UI (marker, journals only / pages only) if time remains.

Branch `m8/impl-small`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-28`,
based on `61279a2` (the worktree was created at an older commit, `f7c9644`; the branch was reset to
`61279a2` before any work). E2E port 6409. Bug entries go to `docs/bugs-inbox/impl-small.md`
(numbers B-230..B-239), never `docs/BUGS.md`.

## 1. Done (committed)

- #15 block timestamps (B-230) — commit "feat(web): block created/edited times in the context
  menu". Files: `apps/web/src/app/{block-times.ts,block-times.test.ts,BlockTimestamps.tsx,
  block-timestamps.css}`, `apps/web/src/data/block-times.ts`, one-line hookup in
  `app/BlockContextMenu.tsx`, `e2e/tests/block-timestamps.spec.ts`. Unit web 689/689; e2e
  block-timestamps + context-menu 16 passed, 1 skipped (pre-existing fixme B-73). Logged B-231
  (open) in passing.

- #15 hash `bf93383`. #16 hashes `b939088` (feature), `486593a` (perf on the 1.7 MB page),
  `fe0f47e` (focus-border style).
- #16 find in page (B-232) — commit "feat(web): find in page with Cmd/Ctrl+F". New:
  `app/page-find.ts` (+test), `views/PageFindBar.tsx`, `views/page-find.css`,
  `editor/pageFilter.ts` (+test), `commands/registrations/page-find.ts`,
  `e2e/tests/page-find.spec.ts`. Hookups: `BlockTree.tsx`, `BlockRowView.tsx`, `PageView.tsx`,
  `CommandLayer.tsx`, `editor-host.ts`, `commands/types.ts` (new `pageView` when-key),
  `registrations/index.ts` (+ its test literals), `editor/focus-request.ts`, spec R7/R44a.
  Unit web 707/707 (one run had a flaky `page-title.test.ts` failure that passed on rerun twice);
  e2e page-find 6/6 plus editing, focus, selection, journals, a-fresh-journal, templates,
  navigation, popups, help, context-menu, block-timestamps: 138 passed, 1 failed, 1 skipped — the
  failure is B-233, reproduced on base `61279a2`.

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

- #17 hash `bb43f02`.
- #18 random page (B-237) — commit "feat(web): nav.randomPage". New:
  `commands/registrations/random-page.ts` (+test), `data/random-page.ts` (+test via WorkerDb),
  `e2e/tests/random-page.spec.ts`; hookups in `registrations/index.ts`, `CommandLayer.tsx`; spec
  R44b. Also tightened `read-only.spec.ts`'s palette check with a positive control (a `fill` of
  ">text" does not switch the palette to commands mode; only a typed ">" does).

- #18 hash `6be055f`.
- #11 search filters (B-239) + the server bug it exposed (B-238: `properties.marker` matched
  nothing) — commit "feat(web,server): search filters for task marker, journals, pages".
  Server: `ops/search.ts` maps marker/priority/repeat to block columns, new
  `ops/search-filters.test.ts`; spec note in `mcp-tools.md`. Web: `views/searchFilters.ts` (+test),
  `views/search-filters.css`, controls in `SearchView.tsx` (+ component test), `properties` in
  `data/api-client.ts`. E2E `search-filters.spec.ts` 2/2 with `views.spec.ts` (31 passed).

- #11 hash `dc8ff90`.
- Final verification (2026-09-13, HEAD `dc8ff90` + the search-filters word fix):
  - `pnpm -r test`: core 332, 17, server 525, web 718 — all passing (1,592).
  - `pnpm -r typecheck`: exit 0.
  - `pnpm nooklet verify` on a fresh copy of the real graph: OK, 20,411 ops.
  - Whole Chromium e2e suite in two halves on port 6409: first half 132 passed, 1 skipped; second
    half 170 passed, 3 failed, 1 skipped. The three: `search-filters.spec.ts` "pages only…" (MY
    bug — "quokka" is also used by `popups.spec.ts`; renamed to "okapi", then popups +
    search-filters + shelf 50/50); `shelf.spec.ts` "Shift+click on a page link…" (passed on rerun);
    `views.spec.ts` "opening the palette while editing and closing it hands focus back to the
    editor" — fails in isolation on the BASE commit `61279a2` too (checked on the extracted copy),
    so pre-existing; not logged as a bug because this branch's numbers B-230..B-239 are used up —
    reported to the coordinator instead.

## 2. In flight

- Nothing. All five items done.

## 3. Next steps, in order

1. Nothing left in the brief. Open follow-ups this branch found (for whoever picks them up):
   B-231 (context-menu padding blurs the editor), B-233 (editing.spec order coupling), B-235
   (page.create drops markdown page properties), B-236 (page.update refuses journal properties),
   the views.spec palette-focus failure above, and B-238's unmapped scheduled/deadline/done.

## 4. Decisions

- `biome check` is not clean repo-wide at `61279a2` (9 errors, 13 warnings, none in my files —
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
  (extracted from `61279a2`, pnpm installed). Use port 6409 only when this branch is not using it.

## 5. How to resume

- `git log --oneline 61279a2..m8/impl-small` for what landed; this file for what is in flight.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-small/`.
- E2E: `cd e2e && NOOKLET_E2E_PORT=6409 pnpm exec playwright test <specs> --project=chromium`.

## 6. Adversarial verification (2026-09-13, second agent)

Verifier working in the same worktree/branch, port 6409. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-small-verify/`.
Baseline: the five new specs 18/18 green at `87302f8`.

Confirmed by browser probes (throwaway spec, not committed):
1. Find filter on: Backspace at the start of a match merged it into the previous VISIBLE row across
   hidden blocks ("keep me" / hidden / hidden / "keep too" -> "keep mekeep too", hidden, hidden);
   Delete at the end did the same forwards. Undo restores. -> fixing (merge uses unfiltered order).
2. Find bar's close button while editing a different block than the one the bar was opened from:
   the caret jumped back to the opening block. -> fixing.
3. Journal stream: a block selection standing in an unlocked day + right-click on a locked day's
   block -> the menu offered Delete/Move/Cycle... for the OTHER day's selected block. -> fixing.
4. `search` with `properties: {"constructor": "x"}` -> 500 `near "Object": syntax error`
   (`TEXT_COLUMN_PROPS[k]` hits Object.prototype). -> fixing.
5. Cmd/Ctrl+F while the palette is open on a page opens the find bar behind the palette and moves
   focus into it; the palette stays on screen. -> log only.
6. Select-all while filtered selects context ancestors too; deleting them deletes their hidden
   children (same semantics as a collapsed parent). -> log only.
Not bugs (checked): Czech/Turkish/emoji highlight ranges are right (an early reading was taken
before the rAF paint); a 20k-char query is fine; timestamps show on a locked page.

Verification progress:
- Committed `b4fd43b` (server: `constructor` key 500) and `2ee90fa` (web: filtered merges, find
  close button, locked right-click context), each with a test that failed before the fix.
- Also found and fixed: Search view Show kept "Pages only" selected over task blocks after a marker
  was chosen (`withMarker`). Logged open: Cmd+F from an uncommitted title rename closes the bar;
  core `normalizePropertyKey` mangles a `constructor::` property (pre-existing, under B-238).
- Real graph copy (952 pages) served by `nooklet serve` on 6409 with the production build: startup
  verify OK (20,411 ops); search marker DONE/LATER/NOW → 55/8/1 hits for "a"; 10 random jumps all
  non-journal pages with content; find on Megapage ("ž", "že", "ře", "the") counted and
  highlighted, Escape restored 201 rows, page version unchanged; context-menu timestamp on an
  imported block "Created 29 Apr 2026 08:30"; no page errors.
- Committed `78b113b` (Search view Show/marker).
- Final numbers at `78b113b`: `pnpm -r test` core 332, plugin-api 17, server 526, web 719 (1,594
  passed, 0 failed); `pnpm -r typecheck` exit 0; biome repo-wide 9 errors / 13 warnings, the same
  as base, none on lines this branch added. Chromium e2e in two halves on 6409: 134 passed + 1
  skipped, and 175 passed + 1 skipped — 0 failed, including `views.spec.ts` "opening the palette
  while editing … hands focus back", which the implementer saw fail (it passed here, in the half).
- Verification done. Open items for whoever merges: the "Open" bullets under B-232 and B-238 in
  `docs/bugs-inbox/impl-small.md`.

