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

## In flight / next

- journal-agenda.spec.ts:182 (live update after an API write): very likely the same lost poke as
  (1). To confirm with `--repeat-each` and full runs.
- sw-update.spec.ts:86 (B-636), mermaid-lazy-cache.spec.ts:30, popups.spec.ts (B-635),
  tasks.spec.ts (B-663), shelf.test.ts (B-669).
- Then three full `pnpm e2e --retries=0` runs, `pnpm -r test` twice, typecheck, biome, leak-check.

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
- Observation (not filed as a bug): the autocomplete highlight is an index, so rows that arrive
  later (the pages list) move a different row under it. A person who presses Enter in the first
  ~100 ms gets "New page", later the top match.
