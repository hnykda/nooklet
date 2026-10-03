# e2e-green — B-623, B-624, B-593, B-561, autocomplete-inside-link flake; full suite twice

Branch: `worktree-agent-a54e807ecce809a96` (based on main `d27d56a`, main merged in again after
server search landed). Ports 6350-6354 (`NOOKLET_E2E_PORT=6350`). Not merged to main.

## Status

Done: `cfc863b` (B-623), `9bd…`/`eaa3b8c` (flake fixes; see `git log`). In flight: the two full
runs (results below once in).

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
`e2e/` uses `.page-view >`. Verified: both specs `--repeat-each 5` 55/55.

### B-624 (`page-delete.spec.ts`) and the `autocomplete-inside-link.spec.ts` flake — test isolation

Not intermittent: under `--repeat-each 5` the first repeat always passed and repeats 1-4 always
failed. `seedPage` (`page.create`, `if_exists: "return"`) returns an existing page untouched, and
these tests leave their page changed: "its 3 blocks" where the second run typed its second,
"zebrawin one typed in B typed in B typed in B"; in autocomplete-inside-link the B-382 test's Enter
creates "Walkin Unmade Page", so the next run's first check (`not.toContain`) failed. Fix (test):
per-run names (`repeatEachIndex-retry`, the `focus-return.spec.ts` convention) and per-run search
word in page-delete. Then the B-382 test failed again at repeat 4: its walk to the "New page" row
was capped at 10 ArrowDowns and each earlier run adds two "Walkin …" rows above it (logged the
rows per step: 11 above by the sixth run). The walk is now bounded by the rows offered.
Verified: both `--repeat-each 5` green (also with connectivity, search-fallback, page-find,
random-page: 154/155 then the fix, and 226 popups+autocomplete run had no autocomplete failure).

### B-561 — search-fallback keyword test

Reproduced on the pre-merge tree by running `popups search-fallback` only: "2 results" for
"wombat" — `popups.spec.ts:358` seeds "unique wombat sentence". Fix (test): the spec's three
search words are its own (`fallbackkwwombat`, `fallbackstalenumbat`, `fallbackfocusbilby`).
Re-verified after merging server search (`3844838`): `--repeat-each 5` green.

### B-543 / B-593 — connectivity "search returns rather than spinning forever"

Reproduced 1 of 5 alone (repeat 0): the draft visible at the end, the outliner branch taken. The
server-search agent's fix on main (wait for `draft.or(firstBlock)`, scoped to today) is what this
branch now carries; mine was dropped in the merge. Green 5/5 here. Residual risk, not seen: a
fresh tab draws the draft until its first snapshot, so on a day that already exists the draft can
still be visible when the branch is chosen and then be swapped out (the B-335 race `openJournal`
avoids by seeding first).

### New, found on the way: `popups.spec.ts` slash menu (2 tests) red alone

"opens at a run start with every item in R54 order" and "TODO / task turns the block into a task"
expected TODO first. `34c8d3e` made an empty/tied graph's inferred workflow `now` (owner
decision), so the spec's "this graph has no tasks, so `todo`" no longer holds, and on the shared
server the inference depends on which markers other specs seeded. Fix (test): both pin `todo` in
Settings first, as `task-workflow.spec.ts` does. 10/10 under `--repeat-each 5`.
`popups.spec.ts` as a whole is NOT repeat-safe (6 other tests fail on repeats 1-4 for the same
seedPage reason); repeat 0 is green. Not fixed — logged below.

## BUGS.md updates to fold in

- B-623 → fixed: cause `6ddfc77` (B-595's `.page-view-body` wrapper). App: `PageFindBar.tsx`
  outline lookup (highlights + scroll-to-match were broken for real users). Test:
  `random-page.spec.ts` selector. Tests: `page-find.spec.ts` (red before), `random-page.spec.ts`.
- B-624 → fixed (test only): repeat/retry carry-over through `seedPage`'s `if_exists: "return"`;
  per-run names in `page-delete.spec.ts` and `autocomplete-inside-link.spec.ts`, and the latter's
  walk bounded by the rows offered.
- B-561 → fixed (test only): own search words in `search-fallback.spec.ts`.
- B-543, B-593 → fixed on main by the server-search agent (connectivity waits for draft-or-block);
  verified 5/5 here. Residual draft-swap race noted above.
- NEW (low, test): `popups.spec.ts` slash-menu order assumed `todo` on an empty graph; stale since
  `34c8d3e`. Fixed: pinned `todo` in Settings.
- NEW (low, test): `popups.spec.ts` is not `--repeat-each`-safe (fixed page names edited by the
  tests: lines 103, 223, 313, 578, 608, 619 fail on repeats 1-4). Open.
