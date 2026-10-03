# e2e-green — B-623, B-624, B-593, B-561, autocomplete-inside-link flake; full suite twice

Branch: `worktree-agent-a54e807ecce809a96` (based on main `d27d56a`). Ports 6350-6354
(`NOOKLET_E2E_PORT=6350`). Not merged to main.

## Status

In flight.

## Findings

### B-623 — `page-find.spec.ts` and `random-page.spec.ts` red on every run

One cause, both specs: `6ddfc77` (B-595, "an empty journal day's page is editable") wrapped the
page view's sections in `<div class="page-view-body">`. Two places addressed the page's outline as
a DIRECT child of `.page-view`:

- **App regression** — `apps/web/src/views/PageFindBar.tsx`'s `outliner()` queried
  `:scope > .vr-outliner`, which since `6ddfc77` matches nothing. Find in page still filtered rows
  (that runs off the data), but painted no highlights (`CSS.highlights` sizes 0/0 — the page-find
  failures) and Enter/Shift+Enter no longer scrolled the current match into view. Fixed in the app:
  `:scope > .page-view-body > .vr-outliner`.
- **Stale test** — `random-page.spec.ts` waited for `.page-view > .vr-outliner .vr-row`; the page
  rendered fine (error-context snapshot shows it). Selector updated to `.page-view-body > …`.

No bisect needed: `git show 6ddfc77` adds the wrapper; no other selector in `apps/web/src` or
`e2e/` uses `.page-view >`.

`page-find.spec.ts` also failed under `--repeat-each 5` (repeats 1-4 of three tests): those tests
edit their page and `seedPage` returns an existing page as-is, so a repeat got the previous
repeat's edits. Names now carry `repeatEachIndex-retry` (the convention `focus-return.spec.ts` uses).

## BUGS.md updates to fold in

- B-623 → fixed: cause `6ddfc77` (B-595's `.page-view-body` wrapper). App: `PageFindBar.tsx`
  outline lookup (highlights + scroll-to-match were broken for real users). Test:
  `random-page.spec.ts` selector. Tests: `page-find.spec.ts` (red before), `random-page.spec.ts`.
