# ADR 016: Desktop app — Tauri, pointed at the local server

Date: 2026-09-11. Status: accepted. Supersedes the desktop half of ADR 005.

> **Amended 2026-09-13.** v1 shipped with the server bundled after all. `apps/desktop/src-tauri/src/main.rs`
> starts `sidecar/node server.mjs` on 6100 from the app's resource dir (`build-sidecar.mjs`
> assembles node, the server, the web build, `vec0` and `esbuild`), unless a server already answers
> there. "Not bundled in v1" below records the decision as it was made; the rest — loopback URL,
> one client one build, no bundled web assets — still holds and is why bundling was additive.
>
> **Amended again 2026-09-13 (desktop-shell, B-530..B-534).** The shell now also injects
> `window.__NOOKLET_DESKTOP__ = {platform, port}` into every page (`NOOKLET_PORT` moves it off
> 6100); sets its own macOS menu (Tauri's default plus Settings…, Reload and Help — the client's
> items reach it as a `nooklet:desktop-menu` DOM event); and sends new-window links to the system
> browser (http, https, mailto only). "One client, one build" has a cost this ADR did not name: the
> window runs whatever client its service worker holds, so an update depends on the worker taking
> over (B-532).

## Decision

- The desktop app is a **Tauri 2** shell. Electron is not used.
- **v1 loads `http://127.0.0.1:6100` directly** — the running `nooklet serve` — rather than
  bundling the web assets. The window is a native macOS app; everything inside it is the same
  client a browser gets, served by the same server.
- The server is **not bundled** in v1. It is started separately, exactly as today.
- v2 may bundle the server as a Tauri **sidecar** so launching the app is enough. That is an
  additive change: the shell keeps pointing at a loopback URL, it just starts the process first.

## Why Tauri rather than Electron

`docs/research/10-desktop-packaging.md` measured this, and the answer flips on one question:
*does the bundle have to carry a JavaScript runtime?*

If it does, Tauri's size advantage collapses — a Node SEA is ~116 MiB on macOS, so Tauri + Node
(~122 MiB) is a wash against Electron (~124 MiB), and *worse* on Linux. That is the case the
research treated as the default, and on those numbers Electron was defensible.

But v1 does not ship a runtime at all, because the server is already running. A thin Tauri shell
is **~5 MB against Electron's ~124 MB** — a factor of ~25, not a rounding error. Electron's whole
reason to exist here was carrying Node, and there is no Node to carry.

The risk that would have killed this was WKWebView's storage policy: the client keeps its replica
in OPFS, and embedded web views get a much tighter quota than browsers (15%/20% rather than
60%/80%), with a widely-repeated claim of a 10 MB per-file cap that would have made the design
impossible. `tools/probes/wkwebview-opfs.swift` settled it directly — 1.2 GB written into a single
file, a ~19.2 GiB quota, `isSecureContext` true in both page and worker, `navigator.locks`
present. Against a 46 MB real graph that is not a constraint. See research/10 §1.

## Why point at the server instead of bundling the client

Tauri's normal shape is to bundle the built frontend and serve it from `tauri://localhost`. That
is the wrong choice here, and the reason is not aesthetic:

- **Same-origin is what makes everything work.** The client gets its token from `GET /api/session`,
  which the server only answers with a credential for a loopback *peer*
  (`packages/server/src/http/app.ts`). It talks to `/api/v1/*` and `ws://…/sync/live` as relative
  URLs. Loading from `tauri://localhost` makes every one of those cross-origin, requiring CORS on
  the server and a custom-scheme exemption in the token logic — new surface, in exactly the code
  that just had an auth bypass.
- **One client, one build.** A bundled frontend is a *second copy* that can drift from whatever the
  server is serving. The stale-service-worker bug (B-20) was precisely this failure mode, and it
  cost several rounds of debugging already-fixed code.
- **`127.0.0.1` is a secure context**, so OPFS and `navigator.locks` work unchanged. A custom
  scheme also qualifies (the probe confirms it), but only the loopback URL gets there *without*
  changing the server.

The cost is honest: **the app is useless if the server is not running.** v1 detects that and says
so rather than showing a blank window. That is the trade — a much smaller, simpler, single-source
app in exchange for requiring the daemon, which the user runs anyway.

## Consequences

- Rust joins the build chain. It is not needed to work on the core, server or web client; only to
  build the desktop app.
- No cross-compilation: Tauri needs a per-OS CI matrix (research/10 §5).
- Signing/notarisation applies when distributing (~$99/yr Apple Developer). Not needed for a local
  build.
- Service workers do not register on `tauri://` on macOS — irrelevant here, since the app loads an
  `http://` origin, but it is a reason not to switch to bundled assets later without thought.
- The open notarisation bug against `externalBin` (tauri#11992) only bites when v2 adds the
  sidecar. Prototype `tauri build --bundles dmg` through real notarisation *before* committing to
  that step.

## Alternatives rejected

- **Electron** — redundant without a bundled Node runtime, and ~25× larger for this shape.
- **Bundling the web assets in Tauri** — creates a second client that can drift, and forces CORS
  plus a custom-scheme exemption into the auth path.
- **A PWA installed from the browser** — already works and remains supported, but gives no
  app bundle, no dock identity, and no future path to a global quick-capture hotkey or tray.
- **A native SwiftUI editor** — measured in research/10 §7: ~7,200 lines of UI to rewrite, against
  ~11,600 lines of portable logic that would carry over. Worth it only if webview text editing
  proves unacceptable on a real device; not a v1 decision.
