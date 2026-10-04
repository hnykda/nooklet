# e2e-green — B-623, B-624, B-593, B-561, autocomplete-inside-link flake; full suite twice

Branch: `worktree-agent-a54e807ecce809a96` (based on main `6496f14`, main merged in again after
server search landed). Ports 6350-6354 (`NOOKLET_E2E_PORT=6350`). Not merged to main.

## Status

Done: `b7194b7` (B-623), `91f013f` and before (flake fixes), the `views.spec` search test,
`4258949` (search-local-only), `e039482` (shelf). Main merged up to `532f941`. In flight: the two
final full runs on the merged tree (see "Full runs").

## Full runs

- Run 1 (main 6496f14 + server search): 726 passed, 1 failed (views.spec:246, a stale search
  test, fixed below), 2 skipped, of 729.
- Run on the `532f941` merge (742 tests): 737 passed, 3 failed, 2 skipped. The failures were
  search-local-only (stale, fixed), the views.spec shelf test (app regression, fixed), and
  untrusted-content Alt+Enter ("Loading…" forever). The last one happened while I had a second
  e2e run going on port 6351 in the same checkout. Both runs rebuild `apps/web/dist`, and a later
  contaminated run showed the server answering `web_client_missing`. That makes it contamination,
  not a finding: it passed when run alone.
  **Never run two e2e suites in one checkout at once, even on different ports.**
- Final runs: below.

## Stale after today's merges (found in the full runs)

- `views.spec.ts` "a failed search shows an error with Retry": since `4a4ffe1` (local-first
  search), a failing server shows this device's hits plus a "server's semantic search failed"
  line. There is no error and no Retry any more. I rewrote the test to that contract (5/5).
- `search-local-only.spec.ts`: since `03a8205`/B-612, an active `kind: "local"` entry opens
  straight into its replica. The test waited 30 s for ConnectView's "Just this device". It is
  red on main too. It now waits for the local sync state (5/5).

## App regression: the shelf is lost on the first reload (`03a8205`)

`apps/web/src/app/shelf.ts` fixed its sessionStorage key from `activeGraphId()` at module load.
On a tab's first load, bootstrap has not adopted a graph yet, so the shelf was written under
`nooklet.shelf.state:~` and the next load (with an id) read nothing. `views.spec.ts` "a shelf
card's crumb…" was red 2/2 without the fix and passes 5/5 with it. The fix: an id-less key is
re-resolved until bootstrap sets one, then stays fixed for the rest of the page load. Test:
`apps/web/src/app/shelf.test.ts` (red before).

## Findings

### B-623 — `page-find.spec.ts` and `random-page.spec.ts` red on every run

One cause, both specs: `7506ea2` (B-595, "an empty journal day's page is editable") wrapped the
page view's sections in `<div class="page-view-body">`. Two places addressed the page's outline as
a DIRECT child of `.page-view`:

- **App regression** — `apps/web/src/views/PageFindBar.tsx`'s `outliner()` queried
  `:scope > .vr-outliner`, which since `7506ea2` matches nothing. Find in page still filtered rows
  (that runs off the data), but painted no highlights (`CSS.highlights` sizes 0/0 — the page-find
  failures) and Enter/Shift+Enter no longer scrolled the current match into view. Fixed in the app:
  `:scope > .page-view-body > .vr-outliner`.
- **Stale test** — `random-page.spec.ts` waited for `.page-view > .vr-outliner .vr-row`; the page
  rendered fine (error-context snapshot shows it). Selector updated to `.page-view-body > …`.

No bisect needed: `git show 7506ea2` adds the wrapper; no other selector in `apps/web/src` or
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
Re-verified after merging server search (`4a4ffe1`): `--repeat-each 5` green.

### B-543 / B-593 — connectivity "search returns rather than spinning forever"

Reproduced 1 of 5 alone (repeat 0): the draft visible at the end, the outliner branch taken. The
server-search agent's fix on main (wait for `draft.or(firstBlock)`, scoped to today) is what this
branch now carries; mine was dropped in the merge. Green 5/5 here. Residual risk, not seen: a
fresh tab draws the draft until its first snapshot, so on a day that already exists the draft can
still be visible when the branch is chosen and then be swapped out (the B-335 race `openJournal`
avoids by seeding first).

### New, found on the way: `popups.spec.ts` slash menu (2 tests) red alone

"opens at a run start with every item in R54 order" and "TODO / task turns the block into a task"
expected TODO first. `7641c43` made an empty/tied graph's inferred workflow `now` (owner
decision), so the spec's "this graph has no tasks, so `todo`" no longer holds, and on the shared
server the inference depends on which markers other specs seeded. Fix (test): both pin `todo` in
Settings first, as `task-workflow.spec.ts` does. 10/10 under `--repeat-each 5`.
`popups.spec.ts` as a whole is NOT repeat-safe (6 other tests fail on repeats 1-4 for the same
seedPage reason); repeat 0 is green. Not fixed — logged below.

## BUGS.md updates to fold in

- B-623 → fixed: cause `7506ea2` (B-595's `.page-view-body` wrapper). App: `PageFindBar.tsx`
  outline lookup (highlights + scroll-to-match were broken for real users). Test:
  `random-page.spec.ts` selector. Tests: `page-find.spec.ts` (red before), `random-page.spec.ts`.
- B-624 → fixed (test only): repeat/retry carry-over through `seedPage`'s `if_exists: "return"`;
  per-run names in `page-delete.spec.ts` and `autocomplete-inside-link.spec.ts`, and the latter's
  walk bounded by the rows offered.
- B-561 → fixed (test only): own search words in `search-fallback.spec.ts`.
- B-543, B-593 → fixed on main by the server-search agent (connectivity waits for draft-or-block);
  verified 5/5 here. Residual draft-swap race noted above.
- NEW (low, test): `popups.spec.ts` slash-menu order assumed `todo` on an empty graph; stale since
  `7641c43`. Fixed: pinned `todo` in Settings.
- NEW (low, test): `popups.spec.ts` is not `--repeat-each`-safe (fixed page names edited by the
  tests: lines 103, 223, 313, 578, 608, 619 fail on repeats 1-4). Open.
- NEW, fixed (low, real): the block shelf made on a tab's first load was gone after a reload
  (`03a8205`). Fix `e039482`. Tests: `apps/web/src/app/shelf.test.ts`, and the e2e shelf-crumb
  test in `views.spec.ts`.
- NEW, fixed (test): the `views.spec.ts` search-failure test has been stale since `4a4ffe1`, and
  `search-local-only.spec.ts` since `03a8205` (red on main).
- NEW (process): concurrent e2e runs in one checkout share `apps/web/dist`. One run's build breaks
  the other's server (`web_client_missing`), and separate ports do not isolate them.

## Final full runs (merged tree `f3ef60d` = main `532f941` + this branch; 742 tests, Chromium+WebKit)

- Run C: **739 passed, 1 failed, 2 skipped** (24.2 m). Failed: `sw-update.spec.ts:86` (B-537's
  test) at its last poll: `{controlled: true, installing: false, waiting: true}` for 60 s after
  the reload. It passed in every other full run (run 1, the `532f941` run, run D) and 10/10 alone
  (`--repeat-each 5`). That makes it a NEW intermittent failure. Not investigated: the test's own
  comment says the reloaded app registers `/sw.js` again, which is one more update, so a worker
  stuck in `waiting` there may be a real takeover race or a test timing issue. Unknown.
- Run D: **740 passed, 0 failed, 2 skipped** (19.7 m).
- The 2 skips are the same in every run.

To fold in: NEW (low, flaky): `sw-update.spec.ts` "a newer worker that takes the page over before
the page registered its own still reloads it (B-537)" failed 1 time in 4 full runs, with a worker
left `waiting`. Open, not investigated.
