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

(nothing yet)

## 2. In flight

- B-224: `apps/web/src/editor/render/tokens.tsx` — `<br>` between paragraph/quote lines.

## 3. Next steps, in order

1. B-224 — br between lines in `BlockContentView`; unit test in `tokens.test.tsx`; e2e in a new
   `e2e/tests/render-views.spec.ts`.
2. B-211 — `data-query-hit-id` on query hits; `PluginFence#fenceContext` must then look for the
   hit/embed id before the row id; the journal agenda's `li` carries `data-block-id` too (same
   trap, log as new).
3. B-225 — `@media (pointer: coarse)` reveal for `.page-history-link` / `.page-icon-button-empty`,
   in a new CSS module; phone e2e (iPhone 13 descriptor).
4. B-200 — `ReferencesPanel` under the missing-page view (linked + tagged; "Link all" cannot work
   on a page that does not exist — `mentions.link` calls `requirePage`).
5. B-171 — `filterTasks` due window matches scheduled OR deadline; unit test; e2e in tasks area.

## 4. Decisions

## 5. How to resume

`git log --oneline cf08d19..m9/render-views` in the worktree; this file's "Next steps".
