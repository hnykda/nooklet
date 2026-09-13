# M9 progress — render-views

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: rendering and view gaps from `docs/BUGS.md` — B-224 (multi-line block runs its lines
together), B-211 (query-fence hit carries `data-block-id`, reveal/flash can land on it), B-225
(title row History link and empty icon slot hover-only, unreachable on a phone), B-200 (a page
that does not exist yet shows none of its references), B-171 (Tasks view due window ignores a
deadline when the task is also scheduled).

Branch `m9/render-views`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-8`,
based on `cf08d19`. E2E port 6404. Bug entries go to `docs/bugs-inbox/render-views.md` (new
numbers B-320..B-329), never `docs/BUGS.md`. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/render-views/`.

## 1. Done (committed)

- B-224 — `e7f1fa6` "fix(web): a multi-line block renders a line break between its lines".
  `render/tokens.tsx#Lines`; tests `tokens.test.tsx` (3 new/changed), new
  `e2e/tests/render-views.spec.ts` (B-224 test). Unit web 1002/1002; e2e render-views, rendering,
  render, embeds, query, editing, block-properties, math-display, parity: 61 passed. The e2e failed
  on the old `tokens.tsx` (`br` count 0).
- B-211 + new B-320 (plugin fence in an embed/query hit got the host block) + new B-321 (journal
  agenda item carried `data-block-id`) — commit "fix(web): only outliner rows carry
  data-block-id". `QueryFenceView.tsx` (`data-query-hit-id`), `JournalAgenda.tsx`
  (`data-agenda-block-id`), `PluginFence.tsx#fenceContext` (`FENCE_OWNER`). Tests:
  `render-seams.test.tsx`, `PluginFence.test.tsx` (+2), `JournalAgenda.test.tsx`, e2e
  `render-views.spec.ts` B-211 test (reproduced in Chromium on the old file). Unit web 1004/1004;
  e2e render-views, query, query-task-tag, query-limits, embeds, plugins, journal-agenda,
  shelf-outline, shelf, review-reactivity: 54 passed.

- B-225 — commit "fix(web): a phone reaches History and Add icon through the page menu".
  `views/page-actions.css` (coarse pointer: row's History link and empty icon slot `display:
  none`), `views/PageActions.tsx` (menu items "Page history" link, "Add icon"),
  new `views/page-icon-request.ts` (signal), `views/PageIcon.tsx` (consumes it), one hookup in
  `views/PageView.tsx` (`pageId`, `icon` props). Tests: new `e2e/tests/render-views-phone.spec.ts`,
  desktop test in `render-views.spec.ts`. e2e render-views(+phone), history, page-export,
  page-icons, phone, page-title-draft, page-rename, read-only, page-identity: 44 passed. Unit web
  1004/1004 (a first run under load timed out in page-title/SearchView/render-seams; all green on
  rerun, file-level and full).

- B-200 — commit "feat(web): a page that does not exist yet shows its references". `PageView.tsx`
  mounts `ReferencesPanel target={canonicalRefName(name)} unlinked={false}` in the missing-page
  branch; `ReferencesPanel.tsx` gains the `unlinked` prop. Two e2e tests in `render-views.spec.ts`.
  Logged B-322 (server `page.backlinks` missing-target branch uses the raw title — reproduced via
  the date test with the raw name) and B-323 (one "Loading…" flake in references.spec, passed on
  rerun). e2e render-views, pages, references, references-cap, references-filters, tagged-pages,
  journal-agenda, journals, page-rename, navigation, link-unlinked: 51/52 then 52/52 on rerun.

- B-171 — commit "fix(web): the Tasks view's due window matches a deadline as well as a scheduled
  date". `views/taskFilters.ts#inDueWindow`; 4 unit cases in `taskFilters.test.ts`; e2e in
  `render-views.spec.ts` (failed on the old file: 1 row, expected 2). Logged B-324 (row label shows
  only `dueDay`). Unit web 1008/1008. e2e render-views, tasks, views, dates: 53 passed, 1 failed —
  `views.spec.ts` "opening the palette while editing…", the known B-161, failed again alone (28/29);
  nothing on this branch touches the palette or editor focus (not revert-checked by this branch).

- Real-graph checks — commit "test(probes): render-views on a copy of the real graph". New
  `tools/probes/render-views-real-graph.mjs`. Graph copy (952 pages, 508 multi-line blocks) served
  on 6414 with the branch's build: `/page/book` shows tagged 1 / linked 9, equal to
  `page.backlinks`; `2023-02-17` 19 and `TTRPG/VTM-alpha` 10 multi-line rows all with the right
  `<br>` count. Not checkable there: B-211 (graph has 0 query fences), B-171 (0 open tasks with both
  a scheduled date and a deadline). Only console error: a 404 image asset absent from the copy.

## 2. In flight

- Final pass.

## 3. Next steps, in order

7. Final: full web unit suite, typecheck, the touched e2e specs together; fill in the return.

## 4. Decisions

- B-225: moved the two hover-only controls into the "…" menu on a coarse pointer rather than
  revealing them in the row (the `all-pages.css` recipe). Measured: revealed, the title input had
  164 of 366 px at 390 px and a name clipped at 13 characters. The menu items are on desktop too.
- B-211: attribute rename (`data-query-hit-id`, `data-agenda-block-id`), as the entry proposed and
  as embeds already do, rather than narrowing every lookup to `.vr-row[data-block-id]` — keeps
  `[data-block-id]` meaning "outliner row" for every present and future caller.

## 5. How to resume

`git log --oneline cf08d19..m9/render-views` in the worktree; this file's "Next steps".
