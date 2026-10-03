# Connection states (B-613, B-614, B-615, B-618)

Branch: `worktree-agent-a94b2c48784f3bb63`, based on main `38e17a6`.

## Done
- B-613 + B-614 (one commit, see `git log`): `SyncState` gains `unauthorized`; the transport
  throws `SyncAuthError` on 401/403 and reports every WS close (`onClose(code)`); 4403 → refused.
  `SyncClient` keeps `authRejected` sticky until a request succeeds; a non-auth WS close waits
  `LIVE_DOWN_GRACE_MS` (1.5 s) then probes with `pull()` — its failure is what says `offline`.
  Indicator: `unauthorized` view (before storage facts), red dot, a visible "Token rejected" button;
  both open `ConnectView` in `repair` mode (address read-only, same entry id, loopback gets a
  "Reload" offer since the server re-mints its web-client token per process).
  e2e `sync-connection-states.spec.ts` (3 tests): red before on 38e17a6 for the refused-token test
  ("Offline — …" label, dot still `synced`) and the server-down test ("Synced" with the proxy
  down); the blip test is a guard, green both before and after. Green after, `--repeat-each=2`.

## In flight
- nothing

## Next steps
1. B-615 (insecure-context page before anything else runs)
2. B-618 (labels from graph.overview, dedupe by resolved URL, /g/<slug> hint, GET /graphs list,
   desktop picker)
3. Full verification run; format the pre-existing biome errors in `tools/probes/sweep-*`.

## Decisions
- Server-down simulation: `page.routeWebSocket` does NOT intercept a socket opened in a dedicated
  worker (checked: 0 routed), so `e2e/helpers/switchable-server.ts` is a TCP proxy on
  `NOOKLET_E2E_PORT + 1` that drops connections and stops listening.
- The probe after the grace period is a `pull()`, not a timer that flips to offline: a server that
  answers HTTP but whose WebSocket is broken (a proxy without upgrade support) is in sync, and
  saying "offline" there would be its own false alarm.
- Re-pair never lets the address change: a different address would attach this replica's history
  to a different graph (ADR 025 forbids that merge).

## How to resume
`git log --oneline 38e17a6..HEAD`, then this file's "Next steps".

## BUGS.md updates to fold in
- **B-613** → `fixed` · **Test:** `e2e/tests/sync-connection-states.spec.ts` "a refused token says
  so, keeps the edit, and re-pairing sends it" (red on 38e17a6); `sync-client.test.ts` "connection
  states" block; `sync-indicator-state.test.ts` B-613 case; `connect-graph.test.ts`
  `repairTargetFor`. Fix: 401/403 on push/pull/snapshot and WS close 4403 → `unauthorized`
  (sticky until a request succeeds); indicator "Token rejected — changes stay on this device until
  you enter a new token" + visible "Token rejected" button → re-pair screen (same entry, address
  read-only, pending ops kept and pushed after reload). Also covers a loopback tab left open across
  a server restart (its per-process web-client token is retired): the re-pair screen offers Reload.
  Not verified: WebKit memory-replica variant from the sweep (the indicator logic puts
  `unauthorized` ahead of `memory`, unit-tested only).
- **B-614** → `fixed` · **Test:** `e2e/tests/sync-connection-states.spec.ts` "with nobody typing,
  Synced gives way to Offline…" (red on 38e17a6) and "a blip … never changes what the dot shows"
  (guard). Fix: WS close → 1.5 s grace → probe `pull()`; failure → `offline`; reconnect → pull →
  `idle`. Each failed reconnect re-probes, so recovery is noticed even without the socket. Not
  verified against a real killed server (the e2e uses a TCP proxy that stops listening).
