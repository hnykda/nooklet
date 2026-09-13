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

**Verified 2026-09-13 (second agent).** `e2e/tests/opfs-pool.spec.ts` passes at the branch head
(2 of 2) and fails with the one line commented out (`element(s) not found` for "still here"). The
two things the entry had by reading only, now run: (1) a REAL first start cut short leaves a short
pool — probe `tools/probes/opfs-pool-interrupted-start.spec.ts` navigated away 70-113 ms after
`/journals` committed and found 1, 1, 1, 2, 4 and 5 files in 6 of 60 runs, every next start on the
fixed client rendering and synced; on the unfixed client 3- and 4-file pools still worked, so only a
one-file pool is fatal. (2) A browser the OLD client already broke recovers on the fixed one — probe
`tools/probes/opfs-pool-upgrade-recovery.mjs`, one persistent profile and origin with the server
restarted between an unfixed and a fixed client build: unfixed, `SAH pool is full. Cannot create file
/nooklet.sqlite3-journal`, nothing rendered, the one file now the database's (4096 bytes); fixed,
same profile, the page rendered, `synced`, an edit survived a reload and reached the server, and the
pool held six files.

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

---

### B-336 (existing)

**Fixed 2026-09-13.** Reproduced first at `70c9bb9`, with a sidecar built by `apps/desktop/build-sidecar.mjs`
and `tools/probes/sidecar-user-plugin.mjs apps/desktop/sidecar 6412`: `hello.say -> 404`, log `plugin
"hello" failed to activate: … Could not resolve "@nooklet/plugin-api" … Could not resolve "zod"`.

The fix ships the host-provided modules as files and points the loader at them:
- `packages/server/src/plugins/bundled.ts#packageHostModules(outDir)` writes `@nooklet/plugin-api`,
  `@nooklet/core`, `zod` and `hono` as one ESM file each (`nooklet__plugin-api.mjs`,
  `nooklet__core.mjs`, `zod.mjs`, `hono.mjs`; 7 KiB, 0.2, 0.7, 0.1 MiB), resolved from the server
  package's own dependencies, platform-neutral so a client half can use them too, each keeping the
  OTHER host modules as imports so a plugin that imports two of them still gets one copy of each.
- `bundler.ts#hostAliasMap` uses `$NOOKLET_HOST_MODULES_DIR/<file>` when the variable is set and the
  file exists, BEFORE `require.resolve` — so a sidecar never picks up a copy from some
  `node_modules` above wherever the app sits. Unset (every `nooklet serve` from the repo), nothing
  changes.
- `build-sidecar.mjs` step 7 writes `sidecar/host-modules/`, and `server.mjs`'s banner sets
  `NOOKLET_HOST_MODULES_DIR` beside `NOOKLET_BUNDLED_PLUGINS_DIR`, so `main.rs` needs no change (the
  whole `sidecar/` directory is already a Tauri resource).

Tests that would have caught it: `packages/server/src/plugins/bundled.test.ts` "a user's plugin
where the host modules are shipped as files (B-336)" — "aliases every host-provided import to the
shipped file, not to node_modules" and "builds, activates, answers its op, and bridges its OpError"
(also checks the plugin's bundle names `zod.mjs`/`nooklet__plugin-api.mjs` as inputs and no
`node_modules/…zod`). With `hostAliasMap` made to ignore the variable (the old behaviour) both fail;
with the fix, server unit 669/669. The whole path is the probe: with a freshly built sidecar,
`hello.say -> 200 {"hi":"there"}`, exit 0; the same sidecar with `host-modules/` deleted: 404 and
the two `Could not resolve` errors again. Also run by hand, the sidecar started as `main.rs` does
on a scratch `NOOKLET_DATA` with a user plugin that has a server half (`defineOp` + `OpError` + `zod`)
and a client half (importing `zod`): the op answered `{"greeting":"Ahoj, Dan!"}`, its `OpError` came
back as 404, the client bundle was served (200), neither bundle mentions `node_modules`, and the
built-ins are listed as before (`tools/probes/sidecar-plugins.mjs`: all checks ok).

The probe's own plugin had to change: it declared an op without `summary`, `annotations` or
`scopes`, and once its imports resolved that op crashed the server at startup — B-402.

---

### B-402 · A plugin op missing `annotations` stops the whole server from starting
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, m10/tests-desktop (verifying B-336)
· **Test:** `packages/server/src/plugins/host.test.ts` "an op missing required OpDef fields is that
plugin's error, and the server still starts (B-402)"

A plugin whose `ctx.ops.register(defineOp({...}))` leaves out `annotations` does not just fail to
load: `nooklet serve` exits at startup with `nooklet: Cannot read properties of undefined (reading
'readOnlyHint')`. Reproduced both ways: with the repo's `pnpm nooklet serve` on a scratch data dir,
and with the built desktop sidecar — where it means the Mac app never starts, and a person cannot
reach Settings → Plugins to turn the plugin off. The op in question was B-336's own probe plugin
(`name`, `description`, `input`, `output`, `scope: "read"`, `handler` — no `summary`,
`annotations`, `scopes`). TypeScript would have refused it, but a plugin is bundled with esbuild,
which does not type-check. `ops/registry.ts#register` checks the name, MCP tool-name clashes and
`render`, but not the rest of `OpDef`'s required fields; mounting the HTTP route then reads
`op.annotations.readOnlyHint` (`registry.ts`, the `GET` alias) and throws outside any per-plugin
guard. The policy the host already follows for other plugin faults (`host.test.ts` "an unsupported
api major is a per-plugin error that never aborts the server") says this should be that plugin's
error, not the server's.

**Fixed 2026-09-13.** `packages/server/src/plugins/ops-bridge.ts#wrapPluginOp` — the one path every
plugin op takes into the registry (`server-context.ts`'s `ctx.ops.register`) — first checks the
fields the registry relies on (`name`, `summary`, `description`, `input`/`output` as schemas with
`safeParse`, `annotations`, `scopes`, `handler`) and throws `op "hello.say" is missing summary,
annotations, scopes — see defineOp's OpDef in @nooklet/plugin-api`. Thrown inside `activate()`, the
host records it as that plugin's error; core ops (TypeScript-checked, and not wrapped) are
untouched. Test that would have caught it: `host.test.ts` "an op missing required OpDef fields is
that plugin's error, and the server still starts (B-402)" — before the fix the test setup itself
threw `TypeError: Cannot read properties of undefined (reading 'readOnlyHint')` at
`registry.ts:493`; after, the plugin is `error` with the fields named and a sibling plugin's op
answers 200. Server unit 670/670. By hand: the same scratch-data `pnpm nooklet serve` that exited
now comes up healthy and logs `plugin "hello" failed to activate: op "hello.say" is missing summary,
annotations, scopes …`; and a rebuilt sidecar, started on a scratch `NOOKLET_DATA` holding that
plugin beside a working one, came up healthy, logged the same error, and served the working plugin's
op and client half.

---

### B-403 · `review-reactivity.spec.ts` "a failed Older changes says so…" loses its older page to the replica's first sync
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (final full e2e
run, chunk `replace.spec.ts`…`views.spec.ts`, load average ≈ 4-6) · **Test:**
`e2e/tests/review-reactivity.spec.ts` "a failed Older changes says so instead of silently
re-enabling the button (B-131)"

After unrouting and clicking "Older changes" a second time, `.history-batch` stayed at 25 for the
whole 10 s (`Expected: 26, Received: 25`, 24 polls). The spec alone passed straight after; that
rerun overwrote the failed run's trace, so the cause was then pinned with a probe instead.

Cause: a race between the test and the DB worker's start, in the test. The History view's first page
comes over HTTP (`data/history.ts#fetchPageHistory`) and is on screen before a fresh context's
replica has bootstrapped. When the first `/sync/snapshot` lands, `SyncClient`'s `onBootstrap` fires a
ChangeEvent naming every table, `usePageHistory`'s first page refetches, and a refetch drops the
appended older pages and discards one still in flight — deliberately (B-132: their cursor belonged
to the previous first page). If that lands just after the retry click, nothing clicks again and the
view stays at 25. Probe `tools/probes/history-older-vs-first-sync.spec.ts`:
- A (forced: snapshot held until the retried older page is in flight, released before its answer):
  25, 7 of 7 over three runs.
- C (unforced: ten runs of the 70c9bb9 flow, logging each `page.history` fetch and click in the
  page): under 56 busy loops (load average ≈ 70), 1 of 10 at 25 — `click@475 older>475 first>490
  (x4) older<491 first<493…496`, the refetches clearing the older page just appended — and in the
  other nine the refetches had been answered 3-195 ms before the retry click (two more unlogged
  batches of ten with the same busy loops: 20 of 20 at 26). With no busy loops (load average 30-50 from
  other agents), 3 of 10 at 25, the refetches starting 0-21 ms after the older answer, and five of
  the seven passes had simply finished before the first sync landed at all. Not a load flake, then:
  it hits when the test outruns the worker.

Not a product bug as the view is designed, and not changed: a person who pages back within the
first half second of a browser's first ever start sees the older batches vanish and "Older changes"
come back, and one more click brings them. (Keeping older pages when the refetched first page is
identical would avoid that, but — by `ops/page-history.ts`'s header — a block moved to another
page takes its history with it, which can empty part of the tail without changing the first page, so
a kept tail could list batches the server no longer does, and Restore walks that list. Left for the
owner.)

**Fixed 2026-09-13.** The test opens the page itself first and waits for its 26 rows — which come
from the replica, so it has bootstrapped — and only then loads History; a warm start fires no
bootstrap and an empty pull names no tables, so nothing refetches. It also names its page with
`runName` so it can be repeated. Test that would have caught it: the spec itself (the forced and
unforced probes show the old flow failing). Proof: the new flow in probe B and the "warm" half of
C (plus a batch of ten logged from the test process) — 37 of 37 at 26, each with exactly one first-page fetch (and, in
B, no second snapshot); the test alone,
`--repeat-each=16` under 56 busy loops (load average 60-87): 16 passed; the whole spec under the same
load: 7 passed.

---

### B-404 · One ChangeEvent naming four tables refetches a History page four times
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (probing B-403) ·
**Test:** none

When a fresh browser's first snapshot lands, the History view fetches its first page four times,
within 1-2 ms of each other (probe `tools/probes/history-older-vs-first-sync.spec.ts` A: five
first-page fetches, once on mount then four at 20-50 ms after the snapshot's release; C logs the same
`first>` quadruple in every cold run that saw the refetch). `data/history.ts#ensureWired`'s
`onChange` sets one version signal per table in `e.tables`, outside Solid's `batch()`, and the
bootstrap names all four (`page`, `block`, `block_prop`, `page_prop`); `usePageHistory`'s resource
source reads all four, so each set reruns the source and calls the fetcher — four `page.history`
requests where one would do. The same unbatched loop is in `data/store.ts`'s `onChange` (`bumpTable`
per table, then `bumpPage` per page id), so by reading every resource there stamped on several
tables refetches once per named table on every pulled or local write too (a `block.prop` op names
two) — not measured. Harmless to correctness (the last answer wins, and each fetcher's side effects
are idempotent), but it multiplies server-backed reads (History, and whatever `store.ts` fetches
over HTTP) on exactly the busy moments. Likely fix: wrap both loops in `batch(() => …)`. Not changed
here: a second bug found while fixing B-403, and `store.ts` feeds every view.

---

### B-405 · B-333's new tokenizer line-length check is itself a load flake on a machine with efficiency cores
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop ·
**Test:** `packages/core/src/tokens.test.ts` "costs the same per character on a line four times as
long"

The check B-333 added compared the best of three ~3 ms CPU runs over an ~83k-character line with the
best of three ~25 ms runs over a ~333k one and required the ratio under 8. Run on its own under 84
busy node loops (load average 100-140), an exact copy of it logging the ratio read **8.32** (1 of
50) and **8.16** (1 of 45) — failed — with a median of 5.8 against 4.4 idle and several runs at
7.0-7.6; at 56 loops the top was 7.61. `process.cpuUsage()` does not cancel load out on this M4 Pro
(10 performance + 4 efficiency cores): a busy scheduler runs the thread on an efficiency core for
whole quanta, which bills about twice the CPU time for the same work. The short side's minimum, a
window under one quantum, nearly always caught an undisturbed stretch; the long side's, spanning
several, often did not — so the ratio was biased upward exactly under load, the thing B-333 was
about.

**Fixed 2026-09-13.** Both sides now tokenize the same number of characters (the short line four
times, the long one once — ~2 ms of CPU each, under a quantum), alternate, and keep the least of
fifteen; the limit is 2 (linear 1, quadratic 4), which is the old 8 over 4. Measured in the same
vitest runs as the old form, at the same load (84 loops, load average 100-140, 45 runs): old form
median 5.81, top 8.16 (failed); new form median 1.083, range 0.92-1.18. Idle: 1.08-1.10. Detection
unchanged: with length-quadratic work planted in `tokenizeContent` (a rescan to the end from every
Nth character), both forms fail for N = 512, 1024, 2048 (new 3.45, 3.01, 2.67), and N = 4096 sits at
the limit in both (new 2.08-2.15 and once under 2; old 8.7-10.1 here, 6.2 in B-333's run). Proof:
the committed test 30 of 30 under 84 loops (load average ≈ 105), and `packages/core` 399 of 399
twice, niced, at the same load.

---

### B-406 · A plugin op whose REST alias lacks `method` or `path` still stops the whole server from starting
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verification of m10/tests-desktop
(B-402's fix) · **Test:** `packages/server/src/plugins/host.test.ts` "a REST alias missing its method
or path is that plugin's error, and the server still starts (B-406)"

B-402's check (`plugins/ops-bridge.ts#assertCompleteOpDef`) refuses an op missing a top-level
required field, but mounting a REST alias reads two more that it does not check. With every
top-level field present, `expose: { http: { method: "GET" } }` throws `TypeError: Cannot read
properties of undefined (reading 'replace')` (`registry.ts#toHonoPath`) and `expose: { http: { path:
"/x" } }` throws `… (reading 'toUpperCase')` (Hono's `app.on`), both from `mountHttp` outside any
per-plugin guard — the plugin test harness's setup itself threw, as B-402's did before its fix. Same
failure as B-402: `nooklet serve` and the desktop app exit at startup over one malformed plugin.
(Checked alongside and fine: a method Hono does not know, a lower-case method, and `mcp: true`
without `render`, which the registry already makes the plugin's error.)

**Fixed 2026-09-13.** `assertCompleteOpDef` also requires a string `method` and `path` when
`expose.http` is an object, and names `expose.http's method and path` as missing otherwise — the
plugin's error, as for B-402. Test: the one above, two such plugins beside a working one; with the
new check disabled it fails at setup with `TypeError: Cannot read properties of undefined (reading
'toUpperCase')`, with it both are `error` and the working plugin's op answers 200. Server
`src/plugins` 62 of 62.

---

### B-407 · B-403's race is also in the two sibling "failed … load" tests, and under load it fails them nearly every time
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop
(B-403's claim "the whole spec: 7 passed" under load) · **Test:**
`e2e/tests/review-reactivity.spec.ts` "a failed trash load says so and Retry recovers…" and "a
failed history load says so and Retry recovers…" (B-131)

Under 56 busy loops (load average ≈ 70), `-g B-131 --repeat-each=12` (stopped after 32 tests):
"a failed Older changes…" (B-403's fixed test) 10 of 10 passed, "a failed history load…" 6 of 11,
"a failed trash load…" 0 of 11 — each failure the 30 s test timeout on `locator.click` of the Retry
button, `element was detached from the DOM, retrying`, with the page showing the loaded view. Both
passed 3 of 3 without the busy loops. Neither test is changed on this branch.

Cause, from the trash failure's trace (network and actions on one clock): the routed `trash.list`
aborted at 44427 ms and the error rendered; the fresh context's `/sync/snapshot` answered only at
44762; its bootstrap ChangeEvent refetched `trash.list` twice (B-404) at 44794, as the test
unrouted (44796) — the pending requests fell through to the network, answered 200, the error
unmounted, and the click waited on a Retry button that no longer existed. It is B-403's race: a view
that fetches over HTTP renders its error before a fresh context's replica has bootstrapped, and the
bootstrap's refetch lands inside the test's error-then-retry sequence. Load only makes the snapshot
late enough to hit it every time. The product does the right thing (it recovered on its own).

**Fixed 2026-09-13.** Both tests now call the spec's new `bootstrapReplica(page, name)` first —
seed a page, open it, wait for a row from the replica — the same step B-403's fix inlined, and only
then route the failure and load Trash / History (a warm start). Proof, under 56 busy loops: the fixed
pair `--repeat-each=8`, 16 of 16 (load average 39-63 as the loops started); and in one control run
with the branch-head copy of the spec beside the fixed one, `--repeat-each=4` (load average
59-69): the old tests failed 1 of 4 each (trash, history), the fixed ones passed 8 of 8.

---

### B-408 · `journal-stream-editing.spec.ts` cannot run with `--repeat-each`
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop (a
`--repeat-each=4` filter on `editing.spec.ts` also matched this spec) · **Test:** the spec itself

The B-292 shape in another spec: "typing in an earlier day keeps editing across the write…" appends
"- earlier day base" to the fixed day `isoOffset(-8)`, so repeat 1 finds repeat 0's block (by then
"earlier day baseabcdef") beside its own and `section.locator(".vr-block-view", { hasText: "earlier
day base" }).click()` is a strict-mode violation — repeats 1-3 failed that way, repeat 0 passed,
under 56 busy loops. Not load: the locator matches two blocks. Likely fix: a per-repeat journal day
(an offset derived from `repeatEachIndex`, kept clear of the days other specs use) or an exact-text
match on this run's block. Not changed here: outside this branch's specs.
