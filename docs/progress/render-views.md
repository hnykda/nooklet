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

## 2. In flight

- B-225 next.

## 3. Next steps, in order

3. B-225 — `@media (pointer: coarse)` reveal for `.page-history-link` / `.page-icon-button-empty`,
   in a new CSS module; phone e2e (iPhone 13 descriptor).
4. B-200 — `ReferencesPanel` under the missing-page view (linked + tagged; "Link all" cannot work
   on a page that does not exist — `mentions.link` calls `requirePage`).
5. B-171 — `filterTasks` due window matches scheduled OR deadline; unit test; e2e in tasks area.

## 4. Decisions

## 5. How to resume

`git log --oneline cf08d19..m9/render-views` in the worktree; this file's "Next steps".
