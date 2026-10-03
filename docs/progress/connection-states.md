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

- B-615: the top of `main.tsx` checks `isSecureContext` + `crypto.randomUUID` +
  `navigator.locks` and renders `src/insecure-context.ts`'s plain-DOM page (why, plus Tailscale
  serve / HTTPS / localhost or SSH tunnel) instead of starting. A first version used a separate
  `entry.ts` that dynamically imported `main.tsx`; the full e2e run showed 19 failures (palette /
  keybinding / mermaid-offline specs pressing keys right after `goto`): with the extra hop, `load`
  fired before the app mounted. Reverted to an in-module gate; those specs pass again. e2e `insecure-context.spec.ts`: red on 38e17a6 (blank white page, screenshot), green
  after. Capacitor: not re-probed (no Simulator allowed); relies on the recorded Simulator probe
  (`docs/progress/real-device-test.md`: `isSecureContext=true`) and on the real app booting there,
  which it cannot do without `crypto.randomUUID`.

- B-618: `graph.overview` returns `graph: {id, label}` (label from the graph's `graph.json`,
  slug without one) so any graph token can name its graph; `connectToGraph` stores it as the entry
  label; placeholder labels ("This graph"/"Remote graph") are replaced lazily when the switcher
  opens, a renamed label never. Rows show name + address. `setConnectedGraphToken` matches entries
  by resolved absolute URL (bare origin → `/g/default` already via `graphBaseUrl`), so the
  same-origin graph is not added twice; the add form refuses the already-active graph outright.
  Add form: `/g/<graph>` hint + "Show graphs on this server (root token)" via `GET /graphs`;
  picking one fills the address and asks for that graph's device token. Desktop launcher: titles
  "<slug> on <host>", `/g/<graph>` hint, and a bare address for an already-listed graph activates
  that entry instead of `add_graph`. e2e: `graph-switcher.spec.ts` B-618 test and
  `desktop-launcher.spec.ts` B-618 test, both red on 38e17a6 (title/label assertions).

## In flight
- nothing

## Verification (on b18bce4 + probe formatting)
- `pnpm -r typecheck`: exit 0. `pnpm -r test`: core 426, plugin-api 17, server 791, web 1444,
  desktop 4 — all pass. `pnpm exec biome check . --diagnostic-level=error`: clean (after
  formatting the sweep's probe files, which failed it on 38e17a6 already).
- e2e (chromium, port 6340): sync-indicator, connectivity, graph-switcher, remote-device,
  desktop-launcher, sync-connection-states, insecure-context, sync-timeout, local-page-creation,
  diagnostics — 28 passed, 1 failed: `connectivity.spec.ts` "search returns rather than spinning
  forever", which fails identically on 38e17a6 (3/3 with `--repeat-each=3`): today's journal shows
  the draft row, the test's `draft.isVisible()` check runs before it renders and the fallback
  clicks a `.vr-block-view` that does not exist. Pre-existing, not touched.
- Full e2e suite, first pass (with the `entry.ts` version of B-615): 674 passed, 19 failed, 2
  skipped. 15 of the 19 were caused by `entry.ts` (see Done, B-615) and pass after the rework.
  The other 4 — `page-find.spec.ts` ×2 (Cmd/Ctrl+F) and `random-page.spec.ts` ×2 — fail
  identically on 38e17a6 (run there: 4 failed). Pre-existing, not touched.
- Full e2e suite, second pass: see below.

## Next steps
1. Nothing left in scope. Fold the BUGS.md entries below.

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
- **B-615** → `fixed` · **Test:** `e2e/tests/insecure-context.spec.ts` (red on 38e17a6: blank
  page), `insecure-context.test.ts`. Fix: the top of `main.tsx` gates before starting anything and
  shows why plus the three fixes. The capability check (randomUUID,
  locks) decides alongside `isSecureContext`. Capacitor `capacitor://localhost` = secure context per
  the recorded Simulator probe (`tools/probes/capacitor-network/`, `docs/progress/real-device-test.md`);
  not re-probed here. Desktop app pointed at a plain-http remote: expected to land on the same page
  (same build), not run.
- **B-618** → `fixed` · **Test:** `e2e/tests/graph-switcher.spec.ts` "B-618: rows carry the
  server's graph names, a bare address is not added twice, and a root token lists graphs" (red on
  38e17a6 at the label assertion; the duplicate-add part was not separately run red),
  `e2e/tests/desktop-launcher.spec.ts` "B-618: two graphs on one server get distinct titles…" (red
  on 38e17a6), `ops.http.test.ts` graph.overview label case, `bootstrap.test.ts` two B-618 cases.
  Fix: see Done. API change: `graph.overview` output gains `graph: {id, label}`
  (`docs/spec/mcp-tools.md` updated). Not done: the Capacitor ConnectView's own server field has no
  `/g/<graph>` hint (only the switcher's add form and the desktop picker do); the desktop dedupe is
  in the launcher JS, `main.rs#add_graph` still compares exact strings.
- New entry (found while doing B-613, fixed): on web, `ConnectView`'s same-origin pairing (and
  so the re-pair screen) verified the token at `/api/v1/graph.overview` with no `/g/<slug>`, which
  the server's bare-origin 307 sends to the DEFAULT graph — on `/g/work` a valid `work` token read
  as "rejected". `connectToGraph` now verifies at `samePathGraphPrefix()`. Severity medium (any
  non-default graph opened in a browser tab without a token could not be paired). **Test:**
  `ConnectView.test.tsx` "on /g/<slug>, verifies against that graph" (red without the fix). Not
  run in a real browser.
- New entry (noticed, not fixed): `e2e/tests/connectivity.spec.ts` "search returns rather than
  spinning forever" fails on main 38e17a6 when run (alone or with the connection specs): the
  `isVisible()` check on `.vr-draft-input` does not wait, so it takes the `.vr-block-view` branch
  on an empty journal and times out. Severity low (test-only).
- Noticed, not fixed (e2e harness): a `route.fetch` carrying a foreign `Origin` header got 403 from
  the per-graph app — same family as the sweep's "same-host reverse proxy 403" entry.
