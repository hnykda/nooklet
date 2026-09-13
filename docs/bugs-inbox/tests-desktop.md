# Bug inbox — m10/tests-desktop

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-400..B-409.

Load for "under load" runs: `N` busy `node -e 'for(;;){}'` loops on the 14-core machine (scripts
`burn.sh`/`unburn.sh` in the branch's scratch dir), e2e on port 6402, production build, Chromium.

---

### B-292 (existing)

**Fixed 2026-09-13.** Reproduced first, at `70c9bb9`: `--repeat-each=3` on an idle machine failed
repeats 1 and 2 with `Expected: 1, Received: 3` / `Received: 4`. The test now seeds its page
through the shared `e2e/helpers#openPage` under `runName("Enter Probe", info)` — a new helper,
`e2e/helpers/api.ts#runName`, that suffixes `repeatEachIndex-retry` (the pattern `views.spec.ts`'s
palette test already used) — instead of `page.evaluate` fetches under a fixed name after an extra
`/journals` load. The same repeat-unsafety was in `page-icons.spec.ts` (the "setting an icon" test
found the previous repeat's rocket: `Expected pattern: /page-icon-button-empty/`) and
`references.spec.ts` ("shows a count" found `2`…`8`; "refreshes after a local edit" found a panel
already there), and both now use `runName` too. Test that would have caught it: the spec itself
under `--repeat-each`. Proof: `editing.spec.ts`, `page-icons.spec.ts`, `references.spec.ts`
together, `--repeat-each=5` under 28 busy loops: 55 passed; `--repeat-each=8` under 56 busy loops
(load average 63 → 68): 88 passed, 0 failed; and with the final specs plus `opfs-pool.spec.ts`,
`--repeat-each=8` under 56 busy loops (load average up to 69): 96 passed, 0 failed.

---

### B-335 (existing)

**Diagnosis 2026-09-13 (m10/tests-desktop).** Reproduced at `70c9bb9` under 56 busy loops (load
average ≈ 65): `editing.spec.ts`'s first three tests, `--repeat-each=8`, failed 3 of 24 with
exactly `locator.blur: Test timeout of 30000ms exceeded … waiting for
locator('.vr-draft-input').first()`. Cause, from the page snapshot of a failure: today's outline
already existed on the server, and its LAST row was a new "seed" block. Every test has a fresh
browser context and so an empty replica; `JournalStreamView` renders today's `VirtualJournalDay`
draft while the stream's first fetch is pending, and that fetch waits for the worker's bootstrap
from `/sync/snapshot` (the window `journal-draft-sync.spec.ts` holds open on purpose, B-243). The
helper saw that draft, filled it, the snapshot landed, the stream swapped the draft for the real
outliner (B-243's `keepUncommittedDraft` appended "seed" to the day), and `blur()` then waited for a
textarea that no longer existed. The longer the snapshot takes, the wider the window — hence load.
Not a product bug: the draft-then-swap is designed, and B-243 keeps what was typed.

**Fixed 2026-09-13.** `e2e/helpers/editor.ts#openJournal` makes today real through the API
(`page.append` of one "seed" block, only when today has no blocks) BEFORE loading `/journals`, then
waits for `.journal-day-today .vr-outliner` — it never touches the draft. It is scoped to
`.journal-day-today` because an "Upcoming" day another spec created renders above today, where an
unscoped `.vr-outliner` `.first()` landed. `editing.spec.ts` now uses the shared helper instead of
its own copy (the helper had been lifted from it and was unused). The draft handover keeps its own
specs (`a-fresh-journal.spec.ts`, `journal-draft-sync.spec.ts`). Test that would have caught it: the
spec's first three tests under load; with the fix, 24 of 24 passed in each of the 88- and 96-test runs
above (load average 63-69). Probe `tools/probes/open-journal-slow-snapshot.spec.ts` holds the snapshot 3 s so the
draft is certainly on screen: the helper returned today's outliner 4 of 4, without committing the
draft (today's block count unchanged). Same draft-fill-blur pattern, not changed (WebKit-only, and
its replica is in memory): `storage.spec.ts` "the app is usable on an in-memory database".

---

### B-356 (existing)

**Fixed 2026-09-13.** Mechanism confirmed, and made deterministic. The title row renders from the
local replica; the server hears of the change when the client's push lands (300 ms debounce, then a
request). The single `page.read` straight after the row updated therefore raced two pushes: if
neither the flag's nor the clear's push had landed, it passed without testing anything (seen: reads
right after setting the flag had no `icon`); if the flag's had and the clear's had not — the steps
between them taking longer than the debounce, i.e. a slow machine — it failed with B-356's exact
`Received: "🇨🇿"`. The test now routes `**/sync/push` with a 1 s delay (installed before the app
loads: a route added later did not reach the DB worker, which is what pushes — seen as the route
handler never running), polls the server until it HAS the flag, clears, and polls until the
property is gone. Test that would have caught it: `e2e/tests/page-icons.spec.ts` "only the first
grapheme is kept, and clearing the field removes the icon". Proof: the same test with its final poll
replaced by one read failed 3 of 3 (`Received value: "🇨🇿"`); the polled test passed 3 of 3, and 8
of 8 in the 96-test run under 56 busy loops (load average up to 69).

---

### B-323 (existing)

**Diagnosis 2026-09-13 (m10/tests-desktop).** A product bug, not load. Reproduced in the entry's own
combined set (render-views, pages, references, references-cap, references-filters, tagged-pages,
journal-agenda, journals, page-rename, navigation, link-unlinked) under 56 busy loops, first try:
the same failure, and the same page — top bar, "Loading…", Help, with the sync indicator EMPTY
(its accessible name fell back to its title, "Show diagnostics"), i.e. the DB worker never finished
starting. The trace's network log has no `/sync/snapshot` request after the second `goto` at all,
and its console has the cause:

    nooklet-opfs-sahpool: Error: SAH pool is full. Cannot create file /nooklet.sqlite3-journal
    sqlite3_step() rc= 14 SQLITE_CANTOPEN SQL = CREATE TABLE page (…
    SQLite3Error: SQLITE_CANTOPEN … at new WorkerDb (ensureSchema)

`opfs-sahpool` gives SQLite one file from a fixed pool per file it opens: the database, and its
rollback journal from the first write. sqlite-wasm 3.53.4 fills the pool (six files) only when it
finds it EMPTY (`OpfsSAHPool` constructor: `getCapacity() ? … : addCapacity(initialCapacity)`), one
file at a time, awaiting each. The spec loads `/journals` (a fresh context, so a first-ever start)
and navigates away ~90 ms later; when that teardown lands inside `addCapacity`, the pool is left
with fewer than six files, and no later start adds any. With one, the database takes it, creating
the schema needs the journal, the journal cannot be opened, `WorkerDb`'s constructor throws, and
every query waits on a worker that never comes up. Load only widens the window. For a person: a
reload or closed tab in the first tenth of a second of the app's first start in a browser leaves
that browser's copy of the app on "Loading…" on every start after (by reading: the pool lives in
OPFS and nothing tops it up; not re-run across a second start). Measured separately with probe
`tools/probes/page-boot-under-load.spec.ts`: when the start is NOT cut short, the page renders in
0.1-0.4 s even at load average 74 or with the e2e server SIGSTOPped 80% of the time — which is why
"load" alone never explained a 10 s hold.

**Fixed 2026-09-13.** `apps/web/src/db/sqlite-wasm-driver.ts#openSqliteWasmDriver` calls
`poolUtil.reserveMinimumCapacity(6)` on every start, before opening the database, so a short pool
is topped up (and a browser already in that state recovers on its next start). Test that would have
caught it: `e2e/tests/opfs-pool.spec.ts` "a start cut short while the OPFS pool was being created
does not leave the app dead" — builds the state an interrupted first start leaves (the pool's
`.nooklet-opfs-sahpool/.opaque` directory holding ONE zero-length file, created from `/icon.svg` so
the app never runs first), then opens a page, checks the indicator says synced (OPFS, not the memory
fallback), edits, and reloads. At `70c9bb9`'s driver it failed with the B-323 page exactly
("Loading…", indicator empty); with the fix it passes (3 of 3 with `storage.spec.ts`; 8 of 8 in the
96-test run under 56 busy loops). The combined set, three fresh runs under 56 busy loops (load
average 60-75): 56 passed each. `references.spec.ts` keeps its extra `/journals` load: it is what
exercised this path.

---

### B-400 · When the DB worker fails to start, every view says "Loading…" forever and nothing says why
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, m10/tests-desktop (diagnosing
B-323) · **Test:** none for the general case (B-323's cause is covered by `e2e/tests/opfs-pool.spec.ts`)

If `db.worker.ts#openDb` rejects — B-323's full SAH pool was one way; a corrupt replica or a quota
error in `ensureSchema` would be others — the app shell renders, the sync indicator is blank, and
the page view shows "Loading…" indefinitely. No message, no way to reset the local copy; the only
trace is `pageerror`s in the console (five unhandled `SQLITE_CANTOPEN` rejections in B-323's trace).
B-43 gave OPFS being UNAVAILABLE a fallback and a label ("not saved locally"), but a failure after
OPFS opened goes nowhere: `initDb`'s rejection is dropped in `main.tsx` (`void initDb(…)`), and
resources whose fetch rejects re-throw on read (`PageView`'s `missing()` reads `page()`) with no
`ErrorBoundary` anywhere in the app, so — most likely; not traced — the view keeps whatever it last
rendered. Likely fix: surface `initDb`'s rejection in the shell
(the indicator and a banner, like B-43's label), and offer the memory fallback or a "reset local
copy" action. Not changed here (a second bug found while fixing B-323).

---

### B-401 · The service worker's runtime caching rules never match anything
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (reading the SW while
diagnosing B-323) · **Test:** none

`apps/web/vite.config.ts` gives workbox `runtimeCaching` patterns `/^\/(api|sync)\//` (NetworkOnly)
and `/^\/assets\//` (CacheFirst, "assets" cache, 30 days). Workbox tests a RegExp route against the
request's full `url.href` (the built `dist/workbox-*.js`: `t.exec(e.href)`), which starts with
`http`, so a pattern anchored at `^\/` can never match. The NetworkOnly rule is harmless dead code
(an unmatched request goes to the network anyway), but the CacheFirst one means the graph's own
assets (`GET /assets/:id`, ADR 013) are never cached by the service worker, so an image pasted into
a page does not load offline — which is what that rule reads as promising. (`navigateFallbackDenylist`
is tested against the pathname and does work.) Likely fix: match on `({ url }) => url.pathname
.startsWith("/assets/")`, after checking what an authenticated asset response should do in a shared
cache. Not verified in a browser; found by reading the generated SW and workbox's matcher.

---

### B-333 (existing)

**Reproduced 2026-09-13 (m10/tests-desktop).** Not at 56 busy loops (all 398 passed; the property
tests at 6-8x their idle time). With `packages/core`'s suite run under `nice -n 20` and 140 busy
loops (load average 102-140): 3 of B-333's 4 failures — "stays far away from quadratic" (673 ms
against 500), "converges regardless of interleaving…" (6,260 ms against 5 s) and "content and each
prop key converge independently…" (5,358 ms against 5 s); "dense adversarial moves" took 16.8 s of
its 30. Cause, as the entry guessed: wall-clock limits. Nothing in these tests is broken, and
nothing in the property tests measures cost at all — a Vitest timeout is the only clock in them.

**Fixed 2026-09-13.**
- `packages/core/src/tokens.test.ts` measures PROCESS CPU TIME (`process.cpuUsage()`) instead of
  `performance.now()`, keeping the 500 ms budget. Probe `tools/probes/cpu-vs-wall-under-load.ts`
  (same 20,000 blocks): idle 18-20 ms CPU and wall; under 140 busy loops, niced (load average
  85-142), 19-32 ms CPU against 144-684 ms wall. That budget never could see what "quadratic" in
  a tokenizer usually means — cost growing with LINE length; its blocks are 70-90 characters — so a
  second test, "costs the same per character on a line four times as long", compares CPU time for
  one ~83k-character line against a ~333k one (best of three each, short first after a warm-up)
  and requires growth under 8 (linear is 4, quadratic 16). Measured growth: 4.4 idle, 4.4-5.1 at
  load average 122-153. It was checked against injected regressions: a char-by-char rescan from
  every 1024th character read 8.3 and failed; every 4096th, 6.2, and every 16384th, 4.9, passed —
  it catches a quadratic once that costs about as much as the tokenizer itself at ~300k characters,
  not a milder one. Both tests take a 60 s Vitest timeout as a hang guard (the scaling check took
  2.7 s of wall time at that load for ~0.2 s of CPU).
- `packages/core/src/sync/sync.property.test.ts`: every fast-check property gets a 120 s Vitest
  timeout, documented at the top of the file as a hang guard only (~100x the slowest idle time).
  `numRuns` is unchanged: these assert over a fixed number of runs, and trimming runs to fit a clock
  is how coverage disappears.

Tests: the tests themselves. Proof: the whole `packages/core` suite three times under `nice -n 20`
and 140 busy loops (load average 122-153): 399 passed each time, with "stays far away from
quadratic" at 451-661 ms wall (the old wall budget would have failed 2 of 3), "converges regardless
of interleaving" at 4.7-5.7 s (over the old 5 s twice) and "dense adversarial moves" at 16-20 s.
Idle: 399 passed.

---

### B-371 (existing)

**Fixed 2026-09-13.** `apps/web/src/commands/hosts/editor-host.ts` now says "editing text" wherever
it said content: the file's design notes (with a paragraph on why the buffer is not the content, for
which blocks the two coincide, and where the split happens — `splitBlockText` in
`registrations/insert-logic.ts` and `registrations/templates.ts`, `editor/editText.ts` as the
boundary), `EditorSelection.content` and its `start`/`end`, `ReplaceRangeSpec.from`/`to`, and
`EditorHost.getSelection`/`replaceRange`. The field keeps its name `content` (renaming it touches
every command; the doc says so). Comment only, no test; checked against the real host
(`app/editor-host.ts#createEditorHost` reads `surface.content()`, the CM6 document).

---

### B-337 (existing)

**Fixed 2026-09-13.** Reproduced first with the new probe `tools/probes/sidecar-web-freshness.mjs`,
which plants a stale client in `apps/web/dist` (an `index.html` saying so, plus a marker file) and
runs the sidecar build: at `70c9bb9` it printed `STALE: sidecar/web/index.html is the planted one;
sidecar/web holds the marker; …`. Step 5 of `apps/desktop/build-sidecar.mjs` now runs `pnpm --filter
@nooklet/web build` every time (Vite empties `dist` first) and fails if that leaves no
`index.html`; the probe then prints `fresh: sidecar/web is a client built by this run`. Test that
would have caught it: that probe (there is no test suite for `apps/desktop`; the probe is the check,
and it exits 1 on a stale client). Cost: the web build, seconds, on every sidecar build.
