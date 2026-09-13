# qafix-m8-views — fixing exploratory-QA findings on the M8 views (real graph, phone width)

Branch `m9/qafix-m8-views`, worktree `.claude/worktrees/wf_e473942f-106-16`, based on `cf08d19`.
e2e port 6461 (also the probe server's port when no e2e run is going). Bugs go to
`docs/bugs-inbox/qafix-m8-views.md` (B-350..B-359), not BUGS.md.
Scratch: `$SCRATCH/m9/qafix-m8-views/` (SCRATCH = the session scratchpad): `e2e.sh <specs>` runs
specs on 6461; `pristine/graph.sqlite` is the real-graph backup (copy into `graph/` for a probe);
`title.mjs`, `menu.mjs` are the Q1 probes (need a server on 6461 serving `graph/`).

Findings: Q1 page title clipped at 390px (medium, B-350 + existing B-225); Q2 block context menu
off-screen in the lower half (medium, B-351); Q3 no touch route to the command palette (medium,
B-352); Q4 cleared search keeps stale results (low, B-353); Q5 ISO journal names in search and
replace (low, B-354); Q6 search filter order splits the date range (low, B-355).

## Done

- Logged all six first: `8afa483`.
- Q1 (B-350, B-225) — title is a growing textarea (`views/PageTitleField.tsx`, `views/page-title.css`);
  hover-only icon slot and History link leave the row under `(hover: none)`; "…" menu gains
  Add/Change icon + Page history (`PageActions.tsx`, `PageIcon.tsx#requestPageIconEdit`).
  Test `e2e/tests/page-title-fit.spec.ts` (5; 4 failed before). Nearby specs: 60 passed, 1 failed
  once then passed on rerun (page-icons race, logged B-356). Web unit 1000/1000 (one load timeout
  on the first run, clean rerun). Real graph probe: all four long names unclipped, phone + desktop.

- Q2 (B-351) — context menu placed from its measured size (`app/menu-placement.ts`, hookup in
  `BlockContextMenu.tsx`), bottom edge = keyboard toolbar's top on a phone, max-height + scroll.
  Tests `e2e/tests/context-menu-placement.spec.ts` (7; 5 failed before), `menu-placement.test.ts`
  (8). Nearby: context-menu, block-timestamps, phone, selection, placement — 46 passed, 1 skipped
  (pre-existing fixme). Web unit 1008/1008. Real graph `/page/TODO` probe `ctx.mjs`: all on screen.

- Q3 (B-352) — "⌘ Command palette" row at the top of the sidebar/drawer (`shell/PaletteButton.tsx`,
  `palette-button.css`, hookup in `Sidebar.tsx`); closes the drawer in drawer mode. Test
  `e2e/tests/phone-palette.spec.ts` (5; all failed with the hookup commented out). Nearby: phone,
  pages, navigation, views, page-export — 68 passed, 1 failed = views "palette … hands focus back"
  (B-161, fails identically with all branch app files at cf08d19; logged). Real graph probe
  `palette.mjs`: Collapse/Expand all and random page by tap from the drawer.

- Q4 (B-353) — `SearchView` shows results/error only while there is a query. Test
  `e2e/tests/search-cleared.spec.ts` (failed before). Nearby: search-filters, views, navigation —
  39 passed, 1 failed = the B-161 palette-focus test again. Real graph probe `search.mjs`: OK.
  The same probe recorded the Q5/Q6 "before" state (ISO names in hits and replace groups; filter
  order Tag, Namespace, Updated after, Task, Show, Journals only, Updated before).

- Q5 (B-354) — `displayRefName` for search hit pages and replace group headings. Test
  `e2e/tests/journal-display-names.spec.ts` (2; each failed without its half of the fix). Nearby:
  search-cleared, search-filters, replace, replace-stale, replace-unicode, dates, journals — 23
  passed. Real graph probe `search.mjs phone`: "Sun, 22.09.2024 › todo…", "Fri, 16.12.2022".

- Q6 (B-355) — "Updated before" moved next to "Updated after". Test: `SearchView.test.tsx` filter
  order (failed before). e2e search specs 6/6. Real graph probe `filters.mjs`: 61px apart.

## In flight

- Final pass: all touched specs in one run, `pnpm -r test`, `pnpm -r typecheck`, biome.

## Next steps

Report back.

## Decisions

- Q1: a textarea rather than hiding more controls — hiding alone leaves any name over ~21
  characters clipped on a phone and 36+ at desktop. Hover-only controls are removed only where
  hover does not exist, and get menu twins on every device (discoverability was B-225's complaint).
- Q2: flip up / pin to bottom from the MEASURED size; the bottom edge is the keyboard toolbar's top
  (the first version missed that; the real-graph screenshot showed it).
- Q3: tried a top-bar ⌘ icon first; on the owner's graph the phone top bar (word count + agents
  badge) had no room — icons shrank to 18px, then the badge went to 3 lines (53px in a 44px bar).
  Moved to the sidebar/drawer: two taps instead of one, zero layout risk, and desktop gets the
  usual "Command palette ⌘K" sidebar row.

## How to resume

`git log --oneline cf08d19..HEAD`; each finding is one commit naming its Q-id and B-number.
