# B-714: real choices on the "different graph" screen

Branch: `worktree-agent-a0eb38c7510ab3860` (based on `dc74e00f`). Never pushed. Status: done,
committed (see `git log` on the branch; one commit).

## What each choice does to the data

1. **Keep this copy as a device-only graph** (primary; "Recommended" when the copy has unsynced
   changes). `data/bootstrap.ts#keepAsDeviceOnlyCopy`. No data moves. The mismatched entry keeps
   its id (so its replica) and loses `baseUrl`/`token`; it becomes `kind: "local"`, label
   "<name> (old copy)" (numbered if taken; slug instead of a placeholder label), `graphInstanceId`
   kept (pinned), `detachedFrom: { address, graphInstanceId, replacedBy, at }`. A checkbox (on by
   default) adds the server's graph as a NEW entry (new id → new empty replica, fresh sync, the
   server's current identity, the old token) and opens it; unchecked, the copy is opened. The list
   is written in one `localStorage` write; the active pointer after it.
2. **Open another graph**: lists the device's other entries on the screen itself; picking one sets
   it active and navigates (`graphEntryUrl`). The mismatched entry is untouched, so opening it again
   shows the screen again.
3. **Discard this copy and re-sync**: as before (B-631), now a secondary, red-text button at the
   bottom, with a second confirmation when the copy has unsynced changes.

The screen names the entry's real address (not `location.host`), lists three likely causes
(re-imported/replaced graph, different data folder, backup of a different graph restored), and
counts `pending_op` rows (after `initDb` the worker has replayed any B-247 batch into it).

## Decisions

- **Replica re-pointing = none.** Everything per-graph is keyed by `replicaKey(entry)` = the entry
  id (or the un-namespaced replica for `legacyReplica`): OPFS file + writer lock, B-247 journal,
  Capacitor checkpoint, journal drafts, shelf. Rejected: giving the copy a new id — that needs a
  pool-file rename plus re-keying four stores, with a crash window between them; the id is
  device-local and never shown.
- **B-633 kept:** no `baseUrl` → `hasSyncTarget()` false → no `syncBaseUrl`, `callOp` refuses.
  `initBootstrap` now returns at once for a local-only entry (no `/api/session` fetch, token `null`,
  no identity compare). Before, on web/desktop a local entry under `/g/<slug>` got that graph's
  token patched in and its identity compared — the copy would have shown the mismatch screen
  forever (the browser-tab e2e fails with this reverted: verified).
- **Promote guard:** a detached copy's `pending_op` holds only the unsynced tail, so "Promote" would
  seed a new server graph with fragments. `updateGraph` throws when asked to give a `detachedFrom`
  entry a `baseUrl`; `canPromoteGraph(entry)` is exported for the switcher to hide the button.
  GraphSwitcher not edited (graph-menu agent owns it) — see the BUGS entry below.
- Screen has its own fixed scroll container: `body` is `overflow: hidden`, and the screen is
  taller than a phone, so the discard choice was unreachable without it.

## Tests

- Unit: `apps/web/src/data/bootstrap.test.ts` "B-714: keeping a mismatched replica as a
  device-only copy" (5 tests: re-pointing keeps the replica key / server entry gets a new one,
  legacy replica, naming, refusal, initBootstrap asks no server).
- e2e: `e2e/tests/graph-mismatch-choices.spec.ts` (phone keep + server graph synced beside it, no
  sync requests from the copy, notes survive reload; browser-tab keep without adding the server;
  switch away and back), `graph-mismatch-discard.spec.ts` updated (new heading, count +
  "Recommended", confirm step). Shared set-up moved to `e2e/helpers/graph-mismatch.ts`.
- Results: web unit 187 files / 1645 tests pass; typecheck clean; leak-check clean; e2e
  mismatch + local-graphs + graph-switcher + desktop-local-graph: 16 passed.
- `biome check --diagnostic-level=error`: 2 errors, both pre-existing in
  `apps/web/src/sync/http-transport-stall.test.ts` (B-707's commit), not touched here.

## Still unverified

- No Simulator run: the phone was the emulated Capacitor shell in Chromium at 390 px.
- Real WKWebView/desktop app not run; the desktop-sized browser tab stands in for it.
- A token kept on the new server entry after a real re-import is probably rejected; the app's
  existing re-enter-token path should handle it, not exercised.

## BUGS.md updates to fold in

- **B-714** → fixed (this branch). Tests: `e2e/tests/graph-mismatch-choices.spec.ts` (3),
  `graph-mismatch-discard.spec.ts` (updated), `data/bootstrap.test.ts` "B-714: …" (5). Summary:
  three choices (keep as device-only — no data moves, entry loses its address, server graph added
  as a new entry; open another graph; discard, now secondary and confirmed when unsynced changes
  exist); real address named; causes listed; unsynced count shown. Also fixed in passing (same
  root): `initBootstrap` used to give a local-only entry on web/desktop the page's graph token and
  compare its identity.
- **New (next free number)** · "Promote" on a B-714 device-only copy would seed a new server graph
  with only its unsynced ops · open · medium · Found 2026-10-04, b714 agent. The copy's history
  came from a server; its `pending_op` holds only the unsynced tail. Data guard landed
  (`updateGraph` refuses a `baseUrl` for a `detachedFrom` entry), but the switcher still shows the
  button, and the guard throws only after `createGraphOnServer` made an empty graph. Wanted: hide
  "Promote" when `!canPromoteGraph(entry)` (graph-menu's switcher), or a real snapshot-seeded
  promote.
- **New (next free number)**, noticed in passing, unverified · `ConnectView` may be cut off on a
  short phone screen: `body` is `overflow: hidden` and `.connect` has no scroll container of its
  own (the mismatch screen hit exactly this). Not reproduced.
- Pre-existing lint errors: `apps/web/src/sync/http-transport-stall.test.ts:49-50`
  `noUnsafeOptionalChaining` fail `biome check --diagnostic-level=error` on main.
