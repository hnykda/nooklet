# e2e-flaky: make the e2e suite deterministic

Branch: the agent worktree branch, based on `6d56c8f`. Local runs use `retries: 0` (the config's
default off CI) and port 6500.

## Done

1. **page-delete.spec.ts:87 "Delete page from the … menu … Restore brings its blocks back"**: an
   app bug, not a test bug. Reproduced 5/10 with `--repeat-each 10` (`Received string: "Start
   typing…"` for 10 s after the restore). The trace showed the restore committing 2 ms after the
   client's pull and live socket started together (in-app navigation to /trash reconnects).
   `SyncClient.pull()` returned at once when a pull was already in flight, so the socket's
   `onOpen` pull and any poke arriving mid-pull were dropped, while the in-flight pull had read
   the server before the commit. Nothing pulled again until the next poke. Fixed in
   `apps/web/src/sync/sync-client.ts`: a pull asked for mid-pull re-runs after it (same shape as
   `flush`/`flushAgain`). Unit test `sync-client.test.ts` › "a pull asked for while one is in
   flight runs again after it (no lost poke)" (red before, green after). page-delete
   `--repeat-each 10`: 50/50 (was 5 failures in 10 of that test).
2. **autocomplete-inside-link.spec.ts:85 (B-382)**: a test bug. Logged the popup rows at the
   moment the test counts them: in the failing run they were `["New page \"Walkin Unmade am
   Page\""]`, 1 row: the pages list had not loaded yet, "New page" was index 0 and already
   highlighted, so the walk stopped at once; then the list arrived and pushed the row down under a
   highlight that stays on index 0. The test now waits for the alias holder's row (present only
   once the pages list has loaded) before walking. With page-delete, `--repeat-each 10`: 120/120.
3. **B-670 harness exits 1 after all tests pass**: `global-setup.ts` piped server output into the
   runner and rewrote `server.log` on every chunk; output arriving after teardown deleted the
   temp dir threw ENOENT. The server now writes to the log file's fd directly.

4. **commands.spec.ts:202 "Open plugin manager…" (B-98)**: failed in full run 1 (`viewport ratio
   0`). An app race. Probe `tools/probes/settings-section-scroll.spec.ts`: the scroll at mount
   lands clamped at the end of a still-short panel (scrollTop 620 of 620, section top 369), then
   the sections above load and push Plugins to top=699 of a 720 px viewport; with more devices on
   the shared server it leaves the view. New `apps/web/src/views/scroll-section.ts` re-applies the
   scroll on every panel resize until the person scrolls/clicks/types; used by Plugins and by
   "Search & embeddings" (same pattern). New test `commands.spec.ts` "Open plugin manager keeps
   Plugins in view while the sections above it load (B-98)" (device list answers late, 40 rows):
   red 3/3 with the old one-off scroll, green with the fix.
5. **mermaid-lazy-cache.spec.ts:30**: an app bug. The service worker's `lazy-chunks` rule matched
   `url.pathname.startsWith("/static/")` only; a document loaded at `/g/<slug>/…` (ADR 025) asks
   for `/g/<slug>/static/…`, so mermaid's 34 chunks never reached the runtime cache, and the offline
   render worked only while Chromium's HTTP cache still held them. The test checked only that the
   core chunk was cached. It now waits for every non-precached chunk the diagram loaded: red 10/10
   with the old rule (lists the 34 `/g/default/static/…` chunks), 20/20 green with the rule
   matching `^(\/g\/[^/]+)?\/static\/` (`apps/web/vite.config.ts`).
6. **tasks.spec.ts (B-663)**: every test pins the `todo` workflow (`pinTaskWorkflow`, new helper
   in `e2e/helpers/editor.ts`), and page names are per run (`nm()`).
7. **popups.spec.ts (B-635)**: pages the tests edit are per run (`nm()`); pages the tests create
   by typing (`Popup Wiki Created Fresh …`, `PopupTagFreshOne…`) carry per-run letters.
8. **journal-agenda.spec.ts:182**: same lost poke as (1); the test's page and task text are per run
   so `--repeat-each` works.
9. **shelf.test.ts (B-669)**: the first test paid the cold transform of `shelf.js` and its imports
   inside its 5 s timeout (0.66 s alone, 1.0 s in the web suite beside an e2e run; the second test,
   re-importing the same files, 4 ms). A `beforeAll` import warms it. Believed fixed: the original
   failure message was not recorded and it did not recur here.

Full run 1 (before 4–9, on `1ad2ffd`): 790 passed, 2 failed, 2 skipped, exit 1. Failed:
commands.spec.ts:202 (above) and phone-images.spec.ts:163 with `ENOSPC: no space left on device`
writing its trace (the disk had 1 GB free; environment, not a flake).

Full run A on `5f5123e` (all of the above): **793 passed, 0 failed, 2 skipped, exit 0** (25.1 m).
Runs B/C were stopped to merge main (coordinator request).

**Coordinator question (page-delete.spec.ts:87 failing even after retry on main `b4fbbf3b`):**
main does not contain this branch's `sync-client.ts` fix. After `git merge main` (`803296d`):
with the fix reverted, `--repeat-each 10` fails 2/10 with the same signature ("Start typing…"
after Restore); with the fix, 10/10 (and 50/50 for the whole spec). At `6d56c8f`, before today's
merges, it failed 5/10. So it is the lost-poke bug, not B-624's carry-over (names are per-run)
and not a regression from All pages' Delete, the in-app confirm or the ref index.

After the merge: merged full run A (`f34e9b6`, retries 0): 804 passed, 2 failed, 2 skipped.
`mermaid-lazy-cache.spec.ts:30` and `sync-connection-states.spec.ts:60`, both "This page doesn't
exist yet" after a reload without the server. Trace: two device ids in one test, so the page load
that showed the page had come up as a follower on an in-memory replica (the previous load's worker
still held the writer lock). Fixed as B-761 (`d9b6a03`, `db/leader-tab.ts`), test
`reload-leader.spec.ts` (red at wait 0). M2 (same tree, before B-761, under other agents' parallel
runs, 37.8 m): 804 passed, 2 failed (WebKit focus-log:76 and phone-ui B-651; both test races,
fixed). Second merge of main (`7a65a90`, includes `1d9845d2`), then coordinator items: phone-ui
B-651 = B-764, desktop-local-graph:113 = B-765 (`588581f`). BUGS.md entries B-760..B-765 written
directly at the coordinator's request.

## In flight / next

- Three full `pnpm e2e --retries=0` runs on `588581f`: running (scratchpad `three-runs.sh`, logs
  `full-A/B/C.log`).
- Done: `pnpm -r test` twice on the first merge (3103 tests each, green), typecheck, biome (no
  errors), leak-check clean. sw-update (B-636): not reproduced, 20/20 alone, 30/30 under load.

## BUGS.md updates to fold in

- NEW (medium, fixed): **A poke or live-socket reconnect that arrives while a pull is in flight
  is lost**, so a write made at that moment by another device or the API stays invisible on this
  device until the next poke. `SyncClient.pull()` returned at once when already pulling. Fixed
  (`sync-client.ts`, pull re-runs once after the in-flight one). Test: `sync-client.test.ts` ›
  "a pull asked for while one is in flight runs again after it (no lost poke)";
  `page-delete.spec.ts:87` under `--repeat-each 10` (5/10 failed before, 10/10 after).
- NEW (low, not fixed): the server registers a `/sync/live` socket only when its `hello` message
  is processed; a commit between the client's pull being answered and that registration gets no
  poke. The client pulls on `onOpen` after sending hello, so the window is only the cross-
  connection reordering of that pull before the hello. Closing it fully: the server sends one
  poke when it registers a socket. Left for the WebSocket-hardening work (`sync/live.ts`).
- B-670: fixed (`e2e/global-setup.ts`: child writes the log fd; nothing in the runner writes after
  teardown).
- B-624 follow-up: the B-382 test's remaining flake was the pages list loading after the walk
  (evidence above); fixed in the test.
- NEW (low, fixed): **"Open plugin manager" (and "Search & embeddings" from the search view) can
  leave the section out of view**: the one scroll at mount ran before the sections above loaded.
  Fixed (`views/scroll-section.ts`). Test: `commands.spec.ts` "Open plugin manager keeps Plugins in
  view while the sections above it load (B-98)" (red 3/3 before). Probe:
  `tools/probes/settings-section-scroll.spec.ts`.
- B-663: fixed (test): `tasks.spec.ts` pins the workflow (`pinTaskWorkflow`).
- B-635: fixed (test): per-run names in `popups.spec.ts`.
- B-669: believed fixed (test): cold import moved out of the test's timeout.
- NEW (medium, fixed): **mermaid diagrams seen under `/g/<slug>/` were not kept for offline use**:
  the service worker's lazy-chunk rule ignored the graph prefix, so offline rendering depended on
  the HTTP cache. Fixed (`apps/web/vite.config.ts`). Test: `mermaid-lazy-cache.spec.ts` "a diagram
  rendered once renders again offline" now checks every chunk (red 10/10 before, 20/20 after).
  (Checked with curl against the e2e server: `/g/default/static/<chunk>` answers 200 with
  `immutable`; bare `/static/<chunk>` answers 307.)
- Pre-existing, not fixed: `commands.spec.ts:159` (Collapse all + selection) fails on every
  `--repeat-each` repeat after the first (fixed page name left collapsed). Passes once per run.
- Observation (not filed as a bug): the autocomplete highlight is an index, so rows that arrive
  later (the pages list) move a different row under it. A person who presses Enter in the first
  ~100 ms gets "New page", later the top match.
