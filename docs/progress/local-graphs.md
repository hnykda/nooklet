# Progress: local-only graphs under ADR 025 (B-611, B-612, B-619)

Owner's next-test items 8/9 (graph switcher, local-only on the phone). Branch:
`worktree-agent-ad349bb7b38028773` (worktree `agent-a349640cdbbaa6d03`), based on `main` at `38e17a6`.

Scratch setup used throughout: `tools/probes/sweep-devices/serve.sh <scratch>/d1 6335`, and
`node tools/probes/sweep-devices/host-proxy.mjs 6336 6335 nooklet.sweep.test apps/web/dist` (a
same-origin stand-in for the Capacitor shell). Probes for this work are in `tools/probes/local-graphs/`.

## Status

- [x] Reproduced B-612 (probe `sweep-devices/local-then-server.probe.ts`, 1/1 runs: switcher lists
      only "Remote graph" after adding a server graph).
- [x] B-619 narrowed down, cause confirmed (below).
- [x] B-611: cause confirmed with a deterministic test (red on `38e17a6`: the server graph got
      2 hits, the page and the block, from a seeded unscoped batch).
- [x] Fixes + migration + tests: `c58ede4`, `3e3c1c5`.
- [x] Required e2e specs, `pnpm -r test`, typecheck, biome (results below).
- [x] Headless Simulator run of the real app (below). All done; nothing in flight.

## B-619: cause (confirmed)

`tools/probes/local-graphs/relaunch-loss.probe.ts` (emulated Capacitor, "Just this device", fill
today's draft, Enter, Escape, reload at once): **lost in 9 of 10 runs** (much more often than the
sweep's 1 of 3), 0 of 9 with 300/1000/3000 ms before the reload (`LG_SETTLE_MS`). Warming the replica
up first (`LG_WARM=1`) changes nothing (4 of 4 lost), so it is not the first-ever page load.

What happens: at the moment of the reload the note is shown as a `.vr-draft-line` (a line Enter
closed that the draft has not written yet), the B-247 journal holds **no** batch for it, and the
replica has no block with that text (checked through a temporary `query()` hook, since removed). The
note is nowhere in OPFS afterwards (`LG_DISK=1` reads every OPFS file raw; positive control at
1000 ms finds it). So nothing was ever written: `VirtualJournalDay.commit()` awaits `prepare()`
(the journal template plus a pool of HLCs: worker round trips, started on focus) before it can build
any op, and the page unloads first. B-247's copy cannot help: it copies ops, and there are none yet.
Same class as B-247 (text that only lives in the page), one step earlier. B-595's draft hand-off
itself is fine. A block typed into the day's tree and reloaded at once survives (0, 550, 800 ms:
`relaunch-whole-db.probe.ts`, 4 of 4 each), because that path does have ops to copy.

## Audit of per-graph client state (done)

| State | Where | Per graph before? | Action |
|---|---|---|---|
| Graph list, active id | `localStorage` `nooklet.graphs`, `nooklet.activeGraphId` | n/a (the list itself) | — |
| Replica file | OPFS sahpool `/nooklet-<entryId>.sqlite3`; `/nooklet.sqlite3` with no entry | yes (M4), except no-entry | B-612: the no-entry replica becomes a real entry |
| Writer lock | Web Lock `nooklet-db-writer[:<entryId>]` | yes | — |
| Unapplied-ops journal (B-247) | `localStorage` `nooklet.unapplied-ops.v1:<owner>:<seq>` | **no** | B-611: now `v2:<scope>:<owner>:<seq>` |
| Native checkpoint (B-573 C) | `@capacitor/filesystem` `Data/nooklet-checkpoint.sqlite3` | **no** | B-611: `nooklet-checkpoint-<entryId>.sqlite3`; old name kept for the un-namespaced replica |
| Owner locks | Web Lock `nooklet.unapplied-ops.owner:<owner>` | per page load, fine | — |
| Shelf | `sessionStorage` `nooklet.shelf.state` (block/page refs) | **no** (survives the switch's same-tab navigation) | scoped: `nooklet.shelf.state:<activeGraphId>` |
| Reference filters | `localStorage` `nooklet.referenceFilters` keyed by page name | no | reading preference only, left |
| Journal title format | `localStorage` `nooklet.journalTitleFormat` | no | a display preference, left |
| Theme, appearance, focus log, command MRU, live consent, window id | `localStorage`/`sessionStorage` | no | device/UI preferences, not graph data, left |
| Service worker caches | Workbox runtime caches | keyed by URL, which carries `/g/<slug>` | — |
| IndexedDB | none used directly; `@capacitor/filesystem`'s web fallback only | — | — |
| GraphMismatchView "Discard the local copy" | removes **every** OPFS entry | **no**: wipes all graphs' replicas | new bug, logged below, not fixed |
| Journal draft copy (new, B-619) | `localStorage` `nooklet.journal-draft.v1:<scope>:<day>` | yes, from the start | — |
| OPFS sahpool pool itself | one pool for all graphs | shared by design | found: install failed while the replaced page still held it → memory replica; fixed (retry) |

## B-611: cause (confirmed) and fix

Cause: `db/client.ts` replayed every orphaned B-247 batch (`nooklet.unapplied-ops.v1:<owner>:<seq>`,
no graph in the key) into whichever replica the next page load opened. A "Just this device" write
still unapplied at a relaunch, then "Add a graph" before the relaunched page's replay ran, landed in
the server graph's replica and was pushed. Evidence: `e2e/tests/local-graphs.spec.ts` "unscoped
batch ... (deterministic)" seeds exactly that state; on `38e17a6` the server graph returns 2 hits (the
page and the block); with the fix 0, and the batch is quarantined. Unit: `db/client-graph-scope.test.ts`
(red on `38e17a6`, green after). The checkpoint (one fixed `CHECKPOINT_PATH`, restored into any empty
replica) is the same class; not seen to fire (needs an evicted or new replica plus a checkpoint from
another graph, which is exactly "Add a local graph" after a server graph's checkpoint) and fixed the
same way.

Fix (`c58ede4`): `data/bootstrap.ts#replicaKey/replicaScope` is the one key for everything
per-graph. Journal keys are `v2:<scope>:...` and a page load only replays its own scope. Checkpoint
path per scope. Migration: `soleLegacyStateOwner()` decides whether exactly one replica could have
written unscoped state (Capacitor: only when every entry is the un-namespaced one; web: when there is
exactly one entry, or none). If so, v1 batches are re-keyed to it and the old checkpoint stays its;
otherwise v1 batches go to `nooklet.unapplied-ops.quarantine.v1:*` and the checkpoint is renamed to
`nooklet-checkpoint.quarantine-<ts>.sqlite3`: kept, never replayed or restored, a console warning
says so. A v1 batch of a still-live page load is left alone.

## B-612: fix

`ConnectView`'s "Just this device" under Capacitor calls `chooseLocalOnly()`: the first time on a
device it adopts the un-namespaced replica (`/nooklet.sqlite3`, the one the page already opened and
the one every pre-fix install wrote) as an entry `{kind: "local", legacyReplica: true}`, active, no
reload; later ones create a namespaced entry and reload. An active local-only entry never shows the
set-up screen again (the copy now says "add a server later from the graph switcher"). Migration for
an install already stranded (server entry active, notes in the un-namespaced file): at boot the worker
inspects that file (`sqlite-wasm-driver.ts#inspectReplica`: has ops and never pulled from a server)
and `main.tsx` adds it as "This device". Adoption happens once per device
(`nooklet.legacyReplicaAdopted`), so removing the entry does not resurrect it. Capacitor only: on
web/desktop the un-namespaced file is a pre-ADR-025 copy of a server graph.

Also fixed here, found while verifying (`graphEntryUrl`): under Capacitor a switch reloads the app
in place instead of `location.assign(<server URL>)`, which would have navigated the WebView to the
server's web client (the sweep's "reading the code only" item).

## B-619: fix

`data/journal-draft-store.ts`: `VirtualJournalDay` keeps its lines in `localStorage` (keyed by
replica and day) from the first keystroke until `applyOps` has recorded the ops (then the B-247
copy carries them). A later load restores and writes them; if the day has a page by then
(`JournalDayOutline`), they are appended to it. Plus two more ways a relaunch lost local-only writes,
found by the probes (`3e3c1c5`):
- A replica with no server became a **follower** (in-memory) when the previous page load still held
  the writer lock: 1 of 10 relaunches. Now waits up to 3 s for the lock (`db.worker.ts#becomeLeader`).
  0 of 20 after.
- The OPFS **pool** is one set of files for all graphs; right after a graph switch the old page still
  held its handles and the new page ran on memory (e2e: `data-state="memory"` after "Add a graph";
  reproduced 1 of 1 with the retry disabled). `installPool` retries `NoModificationAllowedError` for
  up to 5 s.

Probe results: `relaunch-loss.probe.ts` before 9/10 lost; after 0/10, then 0/20 with the lock wait.

## Verification (exact)

- `e2e/tests/local-graphs.spec.ts` (`NOOKLET_E2E_PORT=6335`, chromium): 4 passed (4.7 min). The
  20-run sequence (local-only note, orphaned batch from a busy worker, immediate relaunch, "Add a
  graph", wait past both replay passes, server search, switch back): **0 leaks in 20**, both notes
  back in "This device" every run. On `38e17a6` the deterministic, stranded and B-619 tests fail (3/3).
- graph-switcher, local-page-creation, empty-journal-page, connectivity, remote-device: 11 passed,
  1 failed: `connectivity.spec.ts` "search returns rather than spinning forever" — **pre-existing**,
  fails the same on `38e17a6` (2/2): it checks `.vr-draft-input` with an instant `isVisible()` while
  today is still "Loading…", then clicks a block that does not exist. Not fixed (not this work).
  `graph-switcher.spec.ts` promote test updated: a local-only entry no longer shows the set-up screen.
- `pnpm -r test`: core 426, plugin-api 17, server 790, web 1442 — all passed.
- `pnpm -r typecheck`: clean. `pnpm exec biome check . --diagnostic-level=error`: 8 errors, all in
  other sweeps' probe files on main (`tools/probes/sweep-core/search-trash.mjs`,
  `tools/probes/sweep-devices/{edges,insecure-context,launcher,local-leak,two-clients}.probe.ts`,
  `host-proxy.mjs`), none in files this work touched.
- Simulator (own device `local-graphs-a349`, created, booted headless, deleted after; scratch server
  127.0.0.1:6338 only): `tools/probes/local-graphs/sim-run.sh` drives the real app's DOM
  (`sim-driver.js`). Screenshots in `tools/probes/local-graphs/screenshots/`: 1 note typed in
  local-only; 2 after a real `simctl terminate`+`launch`: the local graph, note there, no set-up
  screen; 3 the server graph "simg" (synced, empty) with the switcher listing "This device" and
  "Remote graph"; 4/5 back on "This device" with the note. Server check: search `4821` and
  `page.list` on simg both empty.

## Still unverified

- A real eviction followed by a checkpoint restore (unchanged from B-573; needs a device).
- The checkpoint migration's `Filesystem.stat`/`rename` against the real iOS plugin (not exercised:
  the Simulator device was fresh, so there was no old checkpoint to move).
- Real taps on a phone (the Simulator run drives the DOM, not the touch layer).
- WebKit's timing for the lock/pool waits (measured in Chromium only).

## BUGS.md updates to fold in

- **B-611** → fixed (`c58ede4`, `3e3c1c5`). Cause, fix, migration as above. Tests:
  `apps/web/src/db/client-graph-scope.test.ts`, `db/unapplied-ops.test.ts` "batches belong to the
  replica..." + "migrateUnscopedBatches", `data/bootstrap.test.ts` "B-611: who could have written...",
  `e2e/tests/local-graphs.spec.ts` (20-run sequence, deterministic unscoped batch).
- **B-612** → fixed (`c58ede4`). Tests: `data/bootstrap.test.ts` "B-612: ...",
  `e2e/tests/local-graphs.spec.ts` "an install stranded by the old ...", and the 20-run test's
  switch-back. Simulator screenshots as above.
- **B-619** → fixed (`c58ede4`, `3e3c1c5`). Cause: the draft's commit waits on `prepare()` (worker
  round trips) before any op exists, so B-247's copy had nothing to copy; 9/10 lost in the probe.
  Tests: `views/VirtualJournalDay.test.tsx` "keeps typed lines until they are ops" (2, red on
  `38e17a6`), `e2e/tests/local-graphs.spec.ts` B-619 (5 runs).
- **New, fixed** (low-medium): under Capacitor, switching to a remote graph called
  `location.assign(<server URL>)`, leaving the app for the server's web client. Now reloads in place.
  Test: `data/bootstrap.test.ts` "graphEntryUrl under Capacitor".
- **New, fixed** (high for local-only): a relaunch could start as an in-memory follower while the old
  page held the writer lock, and a graph switch could start on memory while the old page held the
  shared OPFS pool; with no server, everything written was lost at the next reload. Tests: the
  `local-graphs.spec.ts` 20-run test (fails with `data-state="memory"` when the pool retry is off);
  `relaunch-loss.probe.ts` for the follower case (no deterministic test: depends on teardown timing).
- **New, open** (medium): `GraphMismatchView`'s "Discard the local copy and re-sync" deletes every
  OPFS entry, i.e. every graph's replica on the device, including local-only graphs with notes that
  exist nowhere else. Needs a worker method that unlinks one pool file. Not fixed here.
- **New, open** (low): `e2e/tests/connectivity.spec.ts` "search returns rather than spinning forever"
  fails on `38e17a6` too; the instant `isVisible()` on the draft races the "Loading…" row.
- **Note for B-247**: a follower replica with no sync target replays orphaned batches into memory and
  settles them; with the lock wait above this should no longer happen on relaunch, but a genuine
  second tab of a local-only graph would still do it.
