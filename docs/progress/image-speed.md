# image-speed — B-738: images load slowly, even the second time (2026-10-05)

Branch: the agent's own worktree branch off `ab5de34e`. Not merged, not pushed. e2e port 6540.
New bug numbers from B-900 (used: B-900, an e2e flake).

## Status

**Done** (full e2e: see "Verification"). Nothing in flight.

- `a3d91046` probe: `tools/probes/image-cache/` (counting proxy + Playwright + real WKWebView), B-738 cause logged.
- `1652c876` fix(web): the service worker keeps the graph's pictures (B-401's dead rule).
- `89a6a90e` feat(server): `/assets/:id?w=480|960|1600` variants via sharp; sidecar/container ship sharp.
- `58a0b680` feat(web): the note's `<img>` asks for the variant it draws; e2e `image-variants.spec.ts`.
- docs commit: ADR 035, BUGS (B-738 fixed, B-401 note), specs, this file.

## Root cause (step 1, measured)

`node tools/probes/image-cache/probe.mjs`: real `nooklet serve` + this checkout's production web
build behind a counting proxy throttled to 1.6 MB/s (one shared link); three pictures on one page;
requests and bytes counted AT THE SERVER.

Before any fix, three 3.5 MB noise PNGs (10.5 MB):

| step | Chromium | Playwright WebKit | real WKWebView | WKWebView, SW API removed |
|---|---|---|---|---|
| 1 first visit | 3 req, 10.5 MB, 6.8 s | 3, 10.5 MB, 6.8 s | 3, 10.5 MB, 6.9 s | 3, 10.5 MB, 6.9 s |
| 2 in-app away + Back | **0** | 3, 10.5 MB, 6.7 s | **3, 10.5 MB, 7.6 s** | **0** |
| 3 reload | 0 | 0 | **3, 10.5 MB, 6.8 s** | 0 |
| 4 second tab/view, same store | 0 | 3, 10.5 MB | **3, 10.5 MB, 6.8 s** | 0 |
| R new process, same store | – | – | **3, 10.5 MB, 6.9 s** | 0 |

- **Cause: the service worker, in WKWebView.** While the app's worker controls the page, every
  `<img>` for `/g/<slug>/assets/<id>` reaches the server again on every showing. The worker's
  `/assets/` rule was a RegExp that never matched (B-401), so its fetch handler let the requests
  through, and WebKit's pass-through does not use the HTTP cache. With only the service worker
  API removed (user script `delete Navigator.prototype.serviceWorker`), every repeat is 0.
- Not the headers: the same asset URL on a plain control page in the same WKWebView is cached on
  reload and in a second view; control pictures with `cache-control` only / + `nosniff` / + CSP
  `sandbox` / + validators all cache alike; only one with no `cache-control` is refetched.
- Not the URL: `assetUrl()` is a pure function of the block text, no query, same origin. The
  component does remount on in-app navigation (a new `<img>`); in Chromium that is a memory-cache
  hit, not the cause.
- Chromium was fine all along, so a desktop browser never showed it.
- Playwright's WebKit keeps no disk cache at all (control pictures refetched in a second tab), so
  it cannot stand in for the Mac app here; hence `wkwebview.swift`.
- Capacitor shape (`capacitor://` page, `https://` picture): **not measured.** In the macOS harness
  an `<img>` on a WKURLSchemeHandler page fails before any request (no TLS connection reached the
  proxy; the self-signed certificate is accepted, `fetch(…, {mode: "no-cors"})` from the same page
  works). The phone has no service worker (`sw/register.ts`), so the cause above does not apply.
- A bare `/assets/<id>` 307s to `/g/default/...` (by design, `graphs/mount.ts`); the client always
  uses the prefixed URL.

## Before / after (photos)

Three 12 MP photo-shaped JPEGs (gradients + grain, 12.2 MB), same probe. "Before" = `a3d91046`'s
client (old SW rule, no `?w=`); "after" = `58a0b680`.

| | before | after |
|---|---|---|
| WKWebView (2x), first visit | 3 req, 12.15 MB, 8.0 s | 3 req, 0.38 MB (1600-px variants), 0.8 s incl. generating them |
| WKWebView, in-app Back | 3 req, 12.15 MB, 8.2 s | 0 |
| WKWebView, reload | 3 req, 12.15 MB, 7.8 s | 0 |
| WKWebView, second view, same store | 3 req, 12.15 MB, 7.8 s | 0 |
| WKWebView, new process, same store | 3 req, 12.15 MB, 8.0 s | 0 |
| Chromium (1x), first visit | 3 req, 12.15 MB, 7.9 s | 3 req, 0.05 MB (960-px), 0.5 s |
| Chromium, repeats | 0 | 0 (9 answers from the worker) |
| Playwright WebKit, in-app Back | 3 req, 12.15 MB, 7.7 s | 0 |

The generated photos compress far better as WebP than real ones; a real phone photo at 1600 px is
typically 150-300 kB. Variant generation, measured in the built sidecar (`sidecar-variants.mjs`):
a 3000×2000 PNG to 960 px in 315 ms, then 4 ms from disk; in the container images: 112 ms (arm64),
232 ms (amd64 under QEMU).

## Decisions (ADR 035)

- SW: CacheFirst for same-origin `destination === "image"` `/assets/` requests; `asset-variants`
  (1000, 90 d) and `asset-originals` (60, 30 d), `purgeOnQuotaError`. Not video/audio (Range).
- Server: `w` ∈ {480, 960, 1600} (`ASSET_VARIANT_WIDTHS` in core), else 400; WebP q80;
  `assets/.thumbs/<id>-<w>.webp`; original when nothing to resize; 2 generations at a time;
  `autoOrient`; backup skips `.thumbs`, GC removes an orphan's.
- sharp over WASM (@jsquash 3-5x slower, main-thread, RSS 1 GB; `codec-bench.mjs`). Shipped in the
  sidecar's `lib/node_modules/`, loaded via `NOOKLET_SHARP_PATH`; signed in `desktop-bundle.sh`.
- Client: computed width (not srcset), set after the column is measured, grow-only; `?w=` even when
  the picture may be narrower; viewer/Download/Copy keep the original.

## Verification

- `pnpm -r typecheck`: clean. `pnpm exec biome check --write .`: no new findings in touched files
  (pre-existing warnings in `core/query.ts`, `server/data-api.ts` and others untouched).
- `pnpm -r test`: core 523, plugin-api 17, server 963, web 1851, desktop 4 — all pass.
- Targeted e2e (Chromium + WebKit): image-variants, image-layout, phone-images, image-viewer,
  image-resize, assets, image-insert — pass. `image-variants` "comes from the service worker" is
  red with the old RegExp rule (checked by building the old `vite.config.ts`).
- Full `pnpm e2e` (port 6540, 26.5 min): **886 passed, 6 skipped, 1 failed**: WebKit
  `focus-log.spec.ts:36`, which has no pictures; alone on a fresh server it passed 4 times out of 4
  (logged as B-900). Main was reported at 884 passed; this branch adds 4 tests
  (`image-variants`, two each in Chromium and WebKit).
- Docker: `deploy/docker/Dockerfile` built unchanged for linux/arm64 and linux/amd64; inside each,
  `?w=960` answered a 960-px WebP (`lib/node_modules/ sharp (libvips 8.18.7)` in the build log).
- `node tools/probes/image-cache/sidecar-variants.mjs`: OK (built sidecar copied out of the repo).

## Still unverified

- The phone (Capacitor) shape, above.
- A Developer-ID-signed, notarized app containing the sharp addon and libvips.
- Windows sidecar with `@img/sharp-win32-*`.
- Server memory under a burst of first-time variants of 12 MP photos (bounded to 2 at a time, not
  measured).

## How to resume

Read this file and ADR 035, then `git log --oneline ab5de34e..`. The probe needs
`pnpm --filter @nooklet/web build` first; `ENGINES=wkwebview` runs only the WKWebView half.
