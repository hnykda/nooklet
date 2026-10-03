# Progress — real-device end-to-end test (Mac desktop + own server + physical iPhone)

Goal: make the owner's first real three-device test go smoothly — find and fix blockers in advance
and leave a step-by-step runbook (below, §Runbook). Started 2026-10-03 on branch
`worktree-agent-aaca187218b79b7b0` (fast-forwarded to `main` @ 4f6980f first; the worktree had been
created 635 commits behind).

Owner input mid-task (via coordinator): the server should live on the owner's own infrastructure —
the `homeserver` MicroK8s node described in `<infra-repo>` — behind Tailscale. That
directory and the cluster were treated as READ-ONLY; nothing was applied, no cluster/tailnet
command was run.

## Status

- [x] Blocker 1 — server had no CORS: the iOS app could not reach any server. **Fixed** + tests +
      Simulator proof.
- [x] Blocker 2 — a bare `http://host:port` server address made live sync silently never connect.
      **Fixed** + tests.
- [x] Security — loopback auto-token leaked through a same-host reverse proxy. **Fixed for every
      proxy that sends forwarding headers**; one configuration remains (owner decision D3).
- [x] Info.plist: local-network usage string + ATS `NSAllowsLocalNetworking`.
- [x] Container image `deploy/docker/Dockerfile` — built for linux/amd64 and run locally; found and
      fixed a missing `libatomic1`.
- [x] Draft Helm chart + helmfile/Tailscale/SOPS snippets + Woodpecker pipeline in `deploy/k8s/`
      (DRAFT, not applied, not `helm template`d).
- [x] Runbook (§Runbook below).
- [ ] Not verifiable from here: physical iPhone (signing, local-network prompt, ATS on device),
      Tailscale ingress behaviour (Host header, WSS), the desktop picker click-through.

## Findings, with evidence

### Blocker 1 — no CORS anywhere in the server (FIXED)

The Capacitor app's page and its sync Worker both run at origin `capacitor://localhost`, so every
request to a server is cross-origin, and every one carries `Authorization` (preflighted). The server
had no CORS handling at all: a preflight hit the per-graph bearer gate and got
`401 {"error":{"code":"unauthorized"...}}` with no `Access-Control-Allow-Origin`; at bare origin it
got a 307 (a redirected preflight fails outright).

Proof on the real WKWebView (iOS 26.5 Simulator, `tools/probes/capacitor-network/` — a page + a
dedicated Worker swapped into the app bundle, results on screen and to a no-cors log server),
server at `http://192.168.1.5:<port>` (the Mac's LAN IP), Info.plist with NO ATS keys:

| check | before | after CORS fix |
|---|---|---|
| page `GET /healthz` (simple request) | FAIL `TypeError: Load failed` | PASS 200 |
| page `GET /g/default/api/session` | FAIL | PASS 200 `token:null, reason:non_loopback_host` |
| page `POST /g/default/api/v1/graph.overview` (preflighted) | FAIL | PASS 200 |
| page same POST at bare origin (307) | FAIL | PASS 200 (WebKit follows the 307 after a preflight) |
| worker `GET /g/default/sync/pull` (preflighted) | FAIL | PASS 200 |
| worker `new URL(abs, self.location.origin)` | PASS (`capacitor://localhost`, not `"null"` as in Node) | PASS |
| worker WebSocket `/g/default/sync/live` + hello | **PASS** (WS is not subject to CORS) | PASS |

Fix: `packages/server/src/graphs/mount.ts` — Hono `cors()` on the top-level multi-graph app, ahead
of the `/g` mount and the bare-origin redirect, applied ONLY when `Origin` is in
`APP_SHELL_ORIGINS = {"capacitor://localhost"}`; any other origin (or none) passes through
untouched. Allows `authorization, content-type, accept, idempotency-key`, all methods, max-age 600.
Skips WebSocket upgrades (not subject to CORS; a 101 must not be rewritten). Never `*`:
`/api/session` hands a write token to loopback callers, so a wildcard would let any website in a
browser on the server's own machine read it. No credentials mode is used (bearer tokens, no
cookies). The desktop app needs no entry: in remote mode its window *navigates* to the server URL,
so it is same-origin (`docs/progress/desktop-remote-mode.md`). Tests:
`packages/server/src/graphs/mount.test.ts` "CORS for nooklet's own app shells" (4).

**Real app, end to end on the Simulator** (`tools/probes/capacitor-network/seed-real-app.sh`: real
build, with the exact localStorage state `connectToGraph` leaves injected, since there is no tap
automation here): app booted connected (green sync dot); a block appended on the server via
`page.append` appeared live in the app's Today journal within the 6 s screenshot delay —
server → phone sync over a LAN IP with no ATS keys works. **Phone → server (typing on the phone)
was not exercised** — needs a tap.

### Blocker 2 — bare server address breaks live sync (FIXED)

ConnectView/GraphSwitcher stored the address exactly as typed. Typed as `http://host:6100` (what the
ConnectView hint itself suggests), every `fetch` worked by following the server's 307 to
`/g/default/...`, but a WebSocket never follows a redirect: `tools/probes/ws-bare-origin.mjs` →
`/g/default/sync/live OPEN`, bare `/sync/live NEVER OPENED`. Live sync would silently never connect
(pull-on-resume only). Fix: `apps/web/src/data/connect-graph.ts#graphBaseUrl` — an address with no
path means `<origin>/g/default`; any path is kept as typed. Tests: `data/connect-graph.test.ts` (3),
and the two existing tests that encoded the bare-origin storage updated
(`ConnectView.test.tsx`, `GraphSwitcher.test.tsx`).

### Security — loopback auto-token through a same-host reverse proxy (FIXED, one case left)

`http/app.ts#isLoopbackRequest` hands a write + sync token to a caller whose peer address is
loopback AND whose `Host` names loopback. Behind a reverse proxy on the same machine every peer is
127.0.0.1, so only `Host` guards the token. `tools/probes/loopback-proxy-token.mjs` (proxy on
127.0.0.1 in front of a real server, client asking for `/api/session` as `nooklet.example.ts.net`):

| proxy behaviour | before | after |
|---|---|---|
| keeps client Host (what `tailscale serve` does, per its source — unverified here) | no token (403, Host not allowed) | same |
| rewrites Host to `127.0.0.1:port`, no forwarding headers (bare nginx `proxy_pass`) | **TOKEN HANDED OUT** | **still handed out** |
| rewrites Host + `X-Forwarded-For` (usual proxy config) | **TOKEN HANDED OUT** | no token |

Fix: a request carrying `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` is never
"this machine". Test: `http/host-guard.test.ts` "refuses a token to a request that came through a
same-machine reverse proxy". The remaining case is indistinguishable from a local browser at the
HTTP level → owner decision D3.

**The homeserver/Kubernetes deployment is not affected either way**: the Tailscale operator's ingress
proxy is a separate pod, so the peer address is a pod IP, never loopback. Verified with the built
image under Docker (peer = Docker bridge): `/api/session` → `token:null, reason:non_loopback_host`.

### iOS networking: ATS, local network, HTTPS

- Simulator reached `http://<LAN IP>` with **no ATS keys at all** (table above). Whether a physical
  device does too is **unverified**. Added anyway, both harmless for internet traffic:
  `NSAppTransportSecurity.NSAllowsLocalNetworking = true` (lets ATS allow http to `.local` and
  unqualified names, e.g. `http://dans-mac.local:6100`) and `NSLocalNetworkUsageDescription` (the
  text of iOS 14+'s one-time "find devices on your local network" prompt — the Simulator never
  shows it, a device will on the first LAN request). `plutil -lint` OK, Simulator build OK.
- **With the server on the tailnet over HTTPS (`https://nooklet.<tailnet>.ts.net`) none of the ATS
  / local-network questions apply**: it is HTTPS with a real Let's Encrypt cert, and a Tailscale
  address is not "local network". CORS (blocker 1) and the `/g/default` fix (blocker 2) still apply
  unchanged — they are about origin and WebSockets, not transport.
- B-27 (plain LAN IP cannot run the *browser* client) is about the web/PWA client only — a Safari
  tab at `http://<ip>` is not a secure context, so no OPFS. The Capacitor app is unaffected (its
  page is `capacitor://localhost`, `isSecureContext=true` per the probe). For iPhone Safari as a
  fallback client, use the HTTPS tailnet URL.

### Container image (`deploy/docker/Dockerfile`)

Two-stage: `node:26-bookworm` runs `apps/desktop/build-sidecar.mjs` (the desktop app's own bundler,
which on Linux produces server.mjs + the official Node binary + vec0.so + esbuild + web/ + plugins +
host-modules), runtime `debian:bookworm-slim`, uid 1000, `NOOKLET_DATA=/data`. Verified locally:
`docker buildx build --platform linux/amd64` succeeds; the container serves `/healthz`, the app
(`/g/default/` 200) and `/api/session`; `token create` and the backup loop work via `docker exec` as
uid 1000. **First run failed**: `libatomic.so.1: cannot open shared object file` — the official
Node Linux binary needs `libatomic1`; added. (Does the Linux desktop sidecar have the same gap on
minimal distros? Logged below, not investigated.)

### Hosting on homeserver (from a read-only survey of `<infra-repo>`)

Their pattern, which the draft follows: Helmfile (`k8s/helmfile.yaml`) + one local chart per
service (`k8s/charts/<name>/`), values in `k8s/values/<name>.yaml[.gotmpl]`, secrets in SOPS
(`k8s/environments/secrets.yaml`), images built by Woodpecker into
`registry.container-registry:5000/<name>` (linux/amd64, `provenance: false`, `--set-string` tags),
namespace `apps`, single node (no nodeSelector needed). Tailnet exposure via the Tailscale operator:
an `ingressClassName: tailscale` Ingress declared in the separate `tailscale-services` chart, which
provisions `https://<hostname>.<tailnet>.ts.net` with a Let's Encrypt cert and handles WSS.
Storage: `database-storage` class (hostpath, Retain); their incident doc says
`helm.sh/resource-policy: keep` must be in the chart from the first install. Backups: no per-service
opt-in — a host duplicacy run at 02:00 copies every PVC directory (live files, no SQLite handling).
Closest existing services: `kb-mcp` and `kite` (SQLite on a PVC, tailnet-only).

Draft in `deploy/k8s/` (see its README for the file → destination map): Deployment (1 replica,
`Recreate`, non-root, init container copying the SOPS root token to `/data/root.token`, probes on
`/healthz`), ClusterIP Service 80→6100, PVC (`database-storage`, keep), Secret, a 01:30 CronJob
running `nooklet backup` per graph into `/data/backups/` (7-day retention) so the 02:00 duplicacy run
carries a consistent snapshot. Plus helmfile/environments/tailscale-services/SOPS snippets and a
Woodpecker pipeline. Not applied, not rendered with `helm template` (no helm run, per instructions).

## Owner decisions needed

- **D1 — where the server lives for the test.** (a) homeserver via `deploy/k8s/` (HTTPS tailnet name, no
  ATS/local-network questions, the long-term home — but needs a chart review, SOPS edit, image
  pipeline and a deploy before the test can start); (b) `nooklet serve` on the Mac over the LAN
  (`--host 0.0.0.0 --allow-host <LAN-IP>`), fastest, plain http, depends on the unverified
  device-ATS behaviour; (c) Mac + `tailscale serve --https=443 http://127.0.0.1:6100` (HTTPS
  tailnet name without k8s; same-host proxy — see D3). **Recommend: (b) for the first test today,
  (a) once the chart is reviewed.**
- **D2 — homeserver specifics**: namespace (`apps` assumed), tailnet hostname (`nooklet` →
  `nooklet.<tailnet>.ts.net` assumed), PVC size (5Gi; hostpath PVCs cannot be resized later),
  memory limit (768Mi; node is ~81% used), Node 26 base image (matches release.yml; infra-repo is
  planning node:24), how the image pipeline is triggered (source is in this repo, so infra-repo'
  "source in another repo" `BUILD_TARGET` pattern; repo URL placeholder `OWNER/nooklet` in
  `deploy/k8s/woodpecker-nooklet.yaml`), and whether the in-repo chart lives in infra-repo (their
  convention) or stays here.
- **D3 — same-host proxy that rewrites Host without forwarding headers** still gets a token.
  Options: (a) document "keep Host or send X-Forwarded-For" (done in the runbook); (b) add
  `nooklet serve --no-loopback-token` for proxied deployments; (c) only mint when the peer is
  loopback AND no proxy is configured. **Recommend (b)**, small. Not urgent for homeserver (separate pod)
  or `tailscale serve` (keeps Host).
- **D4 — Tailscale ingress Host header** — whether the operator's proxy forwards
  `nooklet.<tailnet>.ts.net` as `Host` is unverified. If not, nooklet answers 403 naming the host
  it saw; add that to `allowHosts`. Runbook step H6 checks it.

## BUGS.md updates to fold in

- **(new, fixed)** iOS app could not reach any server: no CORS on the server. Preflights got 401
  (graph routes) or 307 (bare origin) without `Access-Control-Allow-Origin`; WebKit reported
  "TypeError: Load failed" for every fetch. Fixed in `graphs/mount.ts` (allowlist
  `capacitor://localhost`). Test: `graphs/mount.test.ts` "CORS for nooklet's own app shells";
  probe `tools/probes/capacitor-network/` (Simulator, before/after).
- **(new, fixed)** A server address typed without a path (`http://host:6100`) was stored as-is;
  HTTP worked via the 307, but `/sync/live` never opened (WebSockets don't follow redirects), so
  live sync silently never connected. Fixed: `connect-graph.ts#graphBaseUrl`. Tests:
  `data/connect-graph.test.ts`, updated `ConnectView.test.tsx`/`GraphSwitcher.test.tsx`. Probe
  `tools/probes/ws-bare-origin.mjs`.
- **(new, fixed — security)** The loopback auto-token was handed to every client behind a same-host
  reverse proxy that rewrites `Host` to its upstream. Fixed for any request with forwarding headers
  (`http/app.ts`). Test: `http/host-guard.test.ts` "refuses a token to a request that came through a
  same-machine reverse proxy". Still open: a proxy that rewrites Host with no forwarding headers
  (owner decision D3). Probe `tools/probes/loopback-proxy-token.mjs`.
- **(new, open)** A WebSocket upgrade to an unrouted bare path (`/sync/live` with no `/g/<id>`)
  hangs — no 101, no error response — instead of failing fast (`tools/probes/ws-bare-origin.mjs`,
  "NEVER OPENED" after 5 s). The client fix above avoids it; the server should answer 404.
- **(new, open)** `nooklet://` deep links reach nothing: `platform.deepLinks.onOpen` has no
  subscriber anywhere in `apps/web/src` (grep), so opening `nooklet://anything` just foregrounds the
  app. A `nooklet://connect?url=…&token=…` link (or QR) would also remove the token-typing step.
- **(new, open)** `nooklet serve --host 0.0.0.0` prints `http://0.0.0.0:6100/...` as the address to
  use — not reachable from a phone; printing the machine's LAN IPs would save a lookup.
- **(new, fixed, deploy only)** The official Node Linux binary needs `libatomic1`; the container
  image failed on first run without it. Possibly also affects the Linux desktop sidecar on minimal
  distros — not investigated.

## Verification (final, 2026-10-03)

- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean (1086 files).
- `packages/server` vitest: 93 files / 785 tests pass. `apps/web` vitest: 163 files / 1386 pass.
- After `pnpm ios:sync` with the real bundle: `xcodebuild -sdk iphonesimulator build` succeeds, and
  `xcodebuild -sdk iphoneos CODE_SIGNING_ALLOWED=NO build` succeeds (arm64; Info.plist in the
  product carries both new keys). Signing itself is the owner's step in Xcode — not verifiable here.
- Simulator probes and the real-app sync run: see the tables above.
- `pnpm e2e` NOT run: no e2e spec covers a cross-origin client, and the changed server paths
  (CORS only for `capacitor://localhost`, token refusal only with forwarding headers) do not
  change what a same-origin browser sees. Run it before merging if in doubt.
- Cleaned up: throwaway servers (6377) and log server (6378) stopped, probe container and image
  removed, Simulator shut down, scratch data dirs deleted. The owner's live server, `~/.nooklet` and
  the desktop app config were never touched.

## How to resume

Everything is committed on the branch. Probes: `tools/probes/capacitor-network/{run.sh,
seed-real-app.sh}` (Simulator, need `pnpm ios:sync` first and a booted simulator; run
`pnpm ios:sync` afterwards to restore the real bundle), `ws-bare-origin.mjs`,
`loopback-proxy-token.mjs`. Ports used during this session: 6377/6378 (6311 was taken by a parallel
agent mid-session — pick unusual ports).

---

# Runbook — first real three-device test

Three clients of one server: the **Mac desktop app** (Tauri) in remote mode, the **iPhone app**
(Capacitor), and optionally **iPhone Safari** as a fallback. Plus each app's local-only mode.

## 0. Choose the server (D1)

**Option L — Mac on the LAN (fastest).** In a terminal you keep open:

```sh
ipconfig getifaddr en0                       # e.g. 192.168.1.5 — the Mac's LAN IP
pnpm nooklet serve --data ~/nooklet-test --host 0.0.0.0 --allow-host 192.168.1.5
```

- Use a separate `--data` dir for the test (not `~/.nooklet`), and any port but the one your live
  server uses (`--port 6200`). The server prints a root token on first run — save it.
- macOS will ask whether `node` may accept incoming connections: **Allow**, or the phone gets a
  timeout.
- The address to type everywhere is `http://192.168.1.5:<port>` (the app adds `/g/default`).
- Both devices on the same Wi-Fi; guest/isolated networks block device-to-device traffic.

**Option H — homeserver over Tailscale (long-term home).** See §Hosting on homeserver below; the address is
`https://nooklet.<tailnet>.ts.net`. Both devices must be on the tailnet (Tailscale app on the
iPhone, VPN on).

**Option T — Mac + `tailscale serve`.** `pnpm nooklet serve --data ~/nooklet-test --port 6200
--allow-host <mac-name>.<tailnet>.ts.net` (loopback bind is fine), then
`tailscale serve --bg --https=443 http://127.0.0.1:6200`. Address:
`https://<mac-name>.<tailnet>.ts.net`. Never put a proxy in front that rewrites `Host` to
`127.0.0.1` without adding `X-Forwarded-For` (D3).

**Sanity check from the Mac before touching a device:**

```sh
curl -s <address>/healthz                                    # {"name":"nooklet","status":"ok"}
curl -si -X OPTIONS -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  <address>/g/default/api/v1/graph.overview | grep -i access-control-allow-origin
# must print: access-control-allow-origin: capacitor://localhost  (else the server is an old build)
```

## 1. Mint one token per device

On the machine with the server's data dir (Option L/T), or `kubectl exec` (Option H):

```sh
pnpm nooklet token create --data ~/nooklet-test --label iphone --scope write --sync
pnpm nooklet token create --data ~/nooklet-test --label mac-desktop --scope write --sync
# homeserver: kubectl -n apps exec deploy/nooklet -- /app/node /app/server.mjs token create \
#         --label iphone --scope write --sync
```

Each is shown once. **Getting it onto the iPhone** (no link/QR flow exists yet): copy it on the Mac
and paste on the iPhone via **Universal Clipboard** (same Apple ID on both, Wi-Fi + Bluetooth on,
Handoff enabled in System Settings → General → AirDrop & Handoff and iPhone Settings → General →
AirPlay & Continuity); or AirDrop a note containing it. Revoke any you leak with
`nooklet token revoke <id>` (`token list` shows ids).

## 2. Build and install the iPhone app

```sh
pnpm install --frozen-lockfile
pnpm ios:sync            # builds apps/web and copies it into the Xcode project
pnpm ios:open            # opens apps/web/ios/App/App.xcodeproj in Xcode
```

In Xcode:

1. Xcode → Settings → Accounts → add your Apple ID (a free account works; apps it signs expire
   after 7 days, re-run to renew).
2. Select the **App** target → **Signing & Capabilities** → tick *Automatically manage signing* →
   **Team**: your account. If it says the bundle id `sh.nooklet.app` is unavailable, change it to
   something unique (e.g. `sh.nooklet.app.dan`) — harmless, the web origin/storage key does not
   depend on it. (This edits `project.pbxproj`; don't commit your team id unless you mean to.)
3. Plug the iPhone in (or same Wi-Fi after first pairing), pick it as the run destination.
4. On the iPhone: Settings → Privacy & Security → **Developer Mode** on (restarts the phone).
5. **Run** (⌘R). First time: iPhone Settings → General → VPN & Device Management → trust your
   developer certificate, then Run again.

Every later code change: `pnpm ios:sync`, then ⌘R in Xcode. (`ios:sync` is the step people forget —
Xcode only bundles whatever is in `ios/App/App/public`.)

## 3. Connect the iPhone

Open nooklet → **Sync with a server** → Server address: the address from step 0 (no `/g/...`
needed) → Device token: paste → Connect.

- Option L: iOS asks "nooklet would like to find and connect to devices on your local network" —
  **Allow** (if you tapped Don't Allow: Settings → Privacy & Security → Local Network → nooklet).
- Expected: app reloads into Today; the sync indicator (cloud icon, top right) turns green.

## 4. Set up the Mac desktop app

```sh
pnpm desktop:install     # rebuilds the sidecar (B-580) + the .app, copies to /Applications
```

(`pnpm desktop` for a dev run; both refresh the sidecar first.) Open nooklet → menu **Switch
Server…** (or the picker if nothing is configured) → **Add a server** → the address from step 0 →
it checks `/healthz`, saves, restarts. The window now loads the client **from the server** (so its
UI is the server's build, not the app's) → paste the `mac-desktop` token on the connect screen.
"This Mac" in the same picker is local mode (its own bundled server, separate graph).

## 5. Test script

Mark each pass/fail in the table in §Results. Keep both devices visible.

1. **Phone → Mac**: on the iPhone, create a page "Phone test" with two bullets. On the Mac it
   appears (Pages / search) within a few seconds without reloading.
2. **Mac → phone**: on the Mac, add a bullet to today's journal. It appears on the phone live.
3. **Same block, both sides**: edit one bullet on the Mac, then the same bullet on the phone; both
   converge to the later edit (last-writer-wins), no duplicate.
4. **Offline edit, then reconnect**: iPhone Airplane Mode on (keep Wi-Fi off) → add 3 bullets and a
   new page → indicator shows offline/pending → Airplane Mode off → within ~30 s everything appears
   on the Mac, nothing lost or duplicated.
5. **Background / resume** (B-573 option B, never tested on a device): background the app 1 min,
   resume → editable immediately, not stuck on "Loading…". Then 10+ min, and a lock/unlock.
6. **Kill and relaunch**: swipe the app away, reopen → same content, still connected.
7. **Keyboard + toolbar**: tap into a bullet → the 12-button keyboard toolbar sits directly above
   the keyboard, not behind it, and the edited line stays visible; indent/outdent/new block work;
   rotate to landscape and back.
8. **Graph switcher**: switcher icon (next to the sync indicator) → **Add a graph** → *local-only* →
   switch to it (empty) → switch back to the server graph (content intact, no mixing).
9. **Local-only mode, phone**: in the local-only graph add a few bullets, kill/relaunch, still there.
10. **Local mode, Mac**: picker → "This Mac" → app restarts on its bundled server → separate graph;
    then back to the server entry.
11. **Deep link**: Safari on the iPhone → `nooklet://test` → the app opens. *Expected today:
    nothing else happens* (nothing subscribes to deep links yet — logged); it must not crash.
12. **Safari fallback** (HTTPS options H/T only): Safari → `https://<name>.<tailnet>.ts.net` →
    paste a token → works like the app. Over plain `http://<LAN-IP>` it cannot work (B-27: not a
    secure context, no OPFS) — expected, not a bug.
13. **Reconnect after server restart**: stop the server 30 s, edit on both devices, start it again →
    both drain and converge.

After the run: `pnpm nooklet verify --data ~/nooklet-test` (op-log replay vs live state).

## 6. When something fails — what to capture

- **JS console of the iPhone app (the most useful thing).** Mac Safari → Settings → Advanced →
  *Show features for web developers*. iPhone → Settings → Apps → Safari → Advanced → **Web
  Inspector** on. Cable the phone (or same network after pairing), run the app from Xcode (Debug
  builds are inspectable), then Mac Safari → **Develop** → your iPhone → **nooklet —
  capacitor://localhost**. Console tab = page errors; the sync engine runs in a **Worker**, listed
  separately under the same app in the Develop menu (or in the Sources tab's Workers section) —
  check both. Network tab shows the failing request and its status. Screenshot or copy the red
  lines.
- **Server side**: the terminal running `nooklet serve` (Option L/T); homeserver:
  `kubectl -n apps logs deploy/nooklet`. A `403 Host "…" is not allowed` names exactly which
  `--allow-host` is missing.
- **"Load failed" on every request** = CORS/connectivity: re-run the curl preflight check in step 0
  from the Mac; from the phone, open `<address>/healthz` in Safari.
- **Native crash / app won't launch**: Xcode's debug console (bottom pane) while running from Xcode.
- **The Simulator** reproduces most networking: `tools/probes/capacitor-network/run.sh` prints a
  PASS/FAIL table for any server URL.
- Log every failure (and every pass of a never-before-tested item: 4, 5, 7, 11) in `docs/BUGS.md`
  with the screenshot/console text, per CLAUDE.md.

## 7. Hosting on homeserver (Option H) — owner applies, after review

Prereqs: decisions D2/D4. Nothing here has been applied.

- H1. Copy `deploy/k8s/charts/nooklet/` → `infra-repo/k8s/charts/nooklet/`, the values file →
  `k8s/values/nooklet.yaml.gotmpl`, merge the four snippets in `deploy/k8s/helmfile-snippet.yaml`.
- H2. Root token into SOPS: `echo "nkroot_$(openssl rand -hex 24)"` →
  `sops k8s/environments/secrets.yaml` → `nooklet: { rootToken: ... }`.
- H3. Image: either the Woodpecker pipeline (`deploy/k8s/woodpecker-nooklet.yaml`, fill in the
  repo URL) or by hand from this repo's root:
  `docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile -t <registry>/nooklet:sha-<8> --push .`
- H4. `helmfile -l name=nooklet sync --state-values-set apps.nooklet.enabled=true --set-string image.tag=sha-<8>`,
  then `helmfile sync -l name=tailscale-services` (delete any stale "nooklet" machine in the
  Tailscale admin first, per infra-repo README).
- H5. `kubectl -n apps get pods` → nooklet Running/Ready; the 01:30 backup CronJob exists.
- H6. From a tailnet device: `curl https://nooklet.<tailnet>.ts.net/healthz` → ok;
  `curl https://nooklet.<tailnet>.ts.net/g/default/api/session` → `token:null` (if it says 403
  `Host "X" is not allowed`, add X to `allowHosts` — D4); run the CORS preflight check from step 0.
- H7. Optional, to bring existing notes: `nooklet import <logseq-dir>` locally into a scratch data
  dir, then promote it to the server from the app (graph switcher → "add a server" on a local graph,
  with the root token), or `kubectl cp` a `nooklet backup` archive in and `nooklet restore` it
  before first start.
- H8. Backups: confirm next morning that `/data/backups/nooklet-default-<date>.tar` exists in the
  PVC directory and that the home server's duplicacy run picked it up. Restore = `nooklet restore <tar>
  --data /data --force` with the deployment scaled to 0.

## Results (fill in during the test)

| # | Check | iPhone app | Mac desktop | Notes / BUGS id |
|---|---|---|---|---|
| 1 | phone → Mac | | | |
| 2 | Mac → phone | | | |
| 3 | same block both sides | | | |
| 4 | offline then reconnect | | | |
| 5 | background / resume | | — | |
| 6 | kill / relaunch | | | |
| 7 | keyboard + toolbar | | — | |
| 8 | graph switcher | | | |
| 9 | local-only (phone) | | — | |
| 10 | local mode (Mac) | — | | |
| 11 | deep link | | — | |
| 12 | Safari fallback | | — | |
| 13 | server restart | | | |
