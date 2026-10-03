# Readiness sweep: devices (Mac desktop + iPhone as clients of the owner's server), 2026-10-03

Base: `main` at `c322269`. App-side flows only. Deployment, TLS, ATS, CORS policy, signing and the
runbook belong to the real-device-test agent (`docs/progress/real-device-test.md`). Where a finding
lands in their area it is flagged for them here but not designed.

Probes are in `tools/probes/sweep-devices/`:
- `serve.sh`: a scratch server.
- `host-proxy.mjs`: a reverse proxy that rewrites `Host`, so a browser on this Mac is a genuine
  **non-loopback** client (no token injected) while keeping a secure context. It has an optional
  static mode that stands in for the Capacitor shell.
- `*.probe.ts`: Playwright, run with `pnpm exec playwright test -c tools/probes/sweep-devices/playwright.config.ts`.
  The env vars are documented in each file.

Ports 6311–6313 were used, and everything was stopped afterwards. `NOOKLET_DATA` was a `mktemp -d`
directory.

## Results

| # | Flow | Result | Evidence |
|---|---|---|---|
| 1 | Server with 2 graphs, root token, `GET/POST /graphs`, device tokens | **works** | curl: 401 without the root token; list and create work; a duplicate id and a bad slug are rejected readably; `token create --graph` works against a running server |
| 1 | ConnectView join (web path) behind a reverse proxy | **works** | `two-clients.probe.ts` 1a/1b: wrong token and other-graph token → "That token was rejected…"; both clients land on `/g/default/journals` |
| 1 | Graph switcher: add a second graph, switch back and forth, `/g/<slug>` (B-586) | **works** | URL `/g/work/…` then `/g/default/…`; links carry `/g/work/`; no content leaks between graphs on screen. Rows are labelled "This graph" / "Remote graph" (see bugs) |
| 1 | Same flow over **plain http on a LAN IP** | **broken (blank page)** | `insecure-context.probe.ts`: the token is accepted, then a white page. Chromium and WebKit both throw `crypto.randomUUID is not a function` and `navigator.locks` undefined. B-27 covers the cause; the silent failure is new |
| 1 | Server behind a reverse proxy on loopback without `--allow-host` | **broken (403)** | The app shell `/g/default/` returns `{"jsonrpc":…,"Invalid Host: …"}` from the MCP sub-app's guard, while `/api/session` returns 200 |
| 2 | Live sync mac ⇄ phone (Chromium ⇄ WebKit at iPhone 15 size) | **works** | ~0.8 s each way, no reload |
| 2 | Offline edits on mac + concurrent edit on phone → reconnect | **works** | Converged in 30 ms after `setOffline(false)`; all 8 blocks on the server |
| 2 | Server restart mid-session | **works** (data) / **wrong indicator** | Recovered in ~1.8 s. The indicator said "Synced" for **30 s+** with the server down and nobody typing, with or without the proxy |
| 2 | Cold reload while the server is unreachable (SW shell + OPFS) | **works** | Journal content shown, indicator says "Offline" |
| 2 | `nooklet verify` | **OK** | default (27 ops), work, leak6 (9 rejected ops, not replayed): all parity OK |
| 3 | Capacitor (emulated) "Just this device" → write → relaunch | **works with settle time** | With a 5 s pause before relaunch the note persists. An immediate relaunch lost it once in 3 runs (see bugs) |
| 3 | Local-only, then "Add a graph" (server) | **broken: data leak** | The local-only note appeared **on the server**, inside an existing graph (2 of 9 runs). The local graph is never listed in the switcher and cannot be switched back to (the list shows only "Remote graph") |
| 4 | `sidecar`, `tauri build --bundles app`, `cargo test` (11), `pnpm test` (4) | **works** | Built `apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app` (worktree) |
| 4 | Launcher picker: list / remove / add / switch / This Mac / recheck | **works (logic)** | `launcher.probe.ts`. Invoke arguments are correct (`remove_graph {id}`, `add_graph {url}`, `set_active_graph {id\|null}`, `restart_app`). Validation messages are right. Unreachable-at-startup shows the picker with an error, then auto-navigates ~1.6 s after the server answers. Reachability had to be routed: a real fetch from the fake origin fails in Playwright |
| 5 | `pnpm ios:sync`, `xcodebuild -sdk iphonesimulator build` | **works** | BUILD SUCCEEDED |
| 5 | Install, launch, screenshot on the iPhone 17 Simulator | **works** | The app booted into a graph left by an earlier session ("Written on the server at 16:43:23 via LAN", red sync dot) |
| 5 | Simulator connected to a scratch server, block both ways | **not checked** | No headless way to type into the WKWebView. **The Simulator window appeared on the owner's screen during this run and the owner closed it.** I only ran `simctl boot`/`install`/`launch`/`io screenshot` and then shut it down |
| 5 | CORS for `capacitor://localhost` → server | **missing** (other agent's area) | Preflight `OPTIONS` → 401, no `Access-Control-Allow-*` on any response. ConnectView's verify fetch from the real app will be blocked |
| 6 | Wrong token / token for the other graph | **works** | Readable "rejected" message |
| 6 | Revoked token, client with a replica | **broken UX** | The indicator says "Offline — changes are kept and sent when back online" indefinitely. Edits never reach the server, and there is no way back to the token screen |
| 6 | Revoked token, WebKit (memory replica) after reload | **broken UX** | "This page doesn't exist yet. Create …" plus "Couldn't load references", and no connect screen |

## Still needs a human on real devices

- Real taps in the iPhone app: connect to the owner's server (after CORS and ATS are fixed), a block
  both ways, the graph switcher (ADR 025 M7), background/resume.
- Whether "Add a graph" in the switcher on Capacitor leaves the app. `goToActiveGraph()` calls
  `location.assign(<absolute server URL>)`, `capacitor.config.ts` has no `server.allowNavigation`,
  and Capacitor opens unlisted URLs outside the WebView. This is from reading the code only; it was
  not seen happen.
- The desktop picker click-through in a real window (list/add/remove/switch), still never done.
- The desktop app in remote mode against an **https** server. Over plain http it will be the blank
  page above, because WKWebView is not a secure context either.

## Verdict

**Desktop: ready to test**, provided the server is reached over **HTTPS**. A tailnet IP over plain
http is not enough. README line 128's "use HTTPS or Tailscale" reads as if it were, so the runbook
should say "Tailscale *with* `tailscale serve`/certs". If a reverse proxy runs on the server's host,
`--allow-host <public name>` is also needed.

**iPhone (Capacitor): not ready**, because the server sends no CORS headers. Use local-only mode,
or Safari over https, until that lands. Tell the owner not to use "Just this device" and then
"Add a graph" on any data they care about.

## BUGS.md entries to fold in

### Local-only content leaks into a server graph after "Add a graph" (orphaned B-247 batches are not graph-scoped)
**Severity:** high (data goes into the wrong graph, which ADR 025 forbids) · **Status:** open, reproduced
Repro: `tools/probes/sweep-devices/local-then-server.probe.ts` with `SWEEP_LT_FAST=1 SWEEP_LT_SETTLE_MS=0`.
On an emulated Capacitor shell:
1. "Just this device", type a note in today's journal.
2. Relaunch at once, then "Just this device" again.
3. Within ~3 s, Switch graph → Add a graph → Sync with a server → `<server>/g/<id>` + token.

The note shows up in that server graph, and the server API returns it. This happened in 1 of 4
runs, plus the first exploratory run against `default`. Suspected cause, from the code:
`db/client.ts`'s unapplied-ops journal (`nooklet.unapplied-ops.v1:*`) is not keyed by graph entry.
A batch still held at the relaunch (seen in localStorage at that moment) replays into whichever
graph the next page load opens. A second suspect, same class, not seen to fire:
`db/capacitor-checkpoint.ts` uses one fixed `CHECKPOINT_PATH` for every graph entry, and restores it
into any graph's empty replica. The same orphan replay presumably applies to web/desktop graph
switching right after an edit (not tested).

### Capacitor local-only graph disappears from the list once a server graph is added
**Severity:** high · **Status:** open
Repro: as above, at any timing. "Just this device" creates no `nooklet.graphs` entry (`App.tsx` only
sets `skipped`), so after a server graph is added the switcher lists only "Remote graph". The
local-only replica, which uses the un-namespaced OPFS file, can no longer be reached. The relaunch
goes straight into the server graph.

### Revoked or invalid stored token shows as "Offline", forever, with no way to re-pair
**Severity:** medium · **Status:** open
Repro: `edges.probe.ts`. Join with a device token, `nooklet token revoke <id>`, reload, edit. The
indicator says "Offline — changes are kept and sent when back online" for 20 s+ and the edit never
reaches the server. The connect screen is not offered, because the entry still has a token. With a
memory replica the page reads "This page doesn't exist yet. Create …". A 401 on push is reported as
`offline` (`sync-client.ts` catch → `state: "offline"`).

### Sync indicator stays "Synced" while the server is down
**Severity:** medium · **Status:** open
Repro: `edges.probe.ts`. Synced client, stop the server, don't type: "Synced" at 1/3/5/10/20/30 s,
with and without a proxy. The live WebSocket's `close` only schedules a reconnect
(`http-transport.ts`) and never changes the status. Only a failed push or pull does.

### Plain-http non-loopback origin: token accepted, then a blank white page with no explanation
**Severity:** medium (B-27 is the cause; this is the silent failure mode) · **Status:** open
Repro: `insecure-context.probe.ts` (`serve.sh <dir> 6311 <LAN-IP>`, open `http://<LAN-IP>:6311/`,
paste a valid token). Errors: `crypto.randomUUID is not a function` (`data/bootstrap.ts`,
`live/window-id.ts`, `app/hosts.ts`) and `navigator.locks` undefined. ConnectView could detect
`!isSecureContext` and say why. The same blank page is expected in the desktop app pointed at a
plain-http remote.

### Behind a same-host reverse proxy, the app shell 403s with an MCP "Invalid Host" JSON-RPC error
**Severity:** medium (deployment trap) · **Status:** open
Repro: `serve.sh <dir> 6311` (bound 127.0.0.1, no `--allow-host`), then
`node host-proxy.mjs 6312 6311` (forwards `Host: nooklet.sweep.test`).
`curl 127.0.0.1:6312/g/default/` → 403 `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: nooklet.sweep.test"}}`,
while `/api/session` returns 200. The cause is `mountMcp`'s `"/"` sub-app guard
(`createMcpHonoApp({host})` auto-enables localhost Host validation). The workaround is
`--allow-host <name>`, but the CLI only suggests it for non-loopback binds.

### Plugin "word-count" fails to activate for every graph after the first
**Severity:** low · **Status:** open
Repro: `nooklet serve` with two graphs, then hit `/g/<second>/…`. The server log shows
`[plugins] plugin "word-count" failed to activate: op "page.wordcount" is already registered`. The
op registry looks process-global across graph contexts.

### Graph switcher labels are generic and can't be told apart
**Severity:** low · **Status:** open
Repro: two-clients 1c. Entries read "This graph" and "Remote graph" rather than the server's graph
label or slug. In the desktop picker, two graphs on one server both have the title `127.0.0.1:6311`
and differ only in the subtitle URL. Adding the bare server address (no `/g/<slug>`) for a graph
already listed creates a duplicate entry with its own replica (two-clients 1d). The add form gives
no hint that `/g/<slug>` is expected, and nothing uses `GET /graphs` to offer a choice.

### Local-only draft-journal write can be lost on an immediate relaunch
**Severity:** low–medium · **Status:** open, intermittent (1 of 3 at 0 ms; 0 of 1 with a 5 s settle)
Repro: `local-then-server.probe.ts` with `SWEEP_LT_SETTLE_MS=0`: fill today's draft, Enter, Escape,
reload at once. One run showed the note momentarily, then an empty day. Possibly B-247 territory,
not narrowed down.
