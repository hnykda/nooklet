# ADR 035: Resized picture variants at `/assets/:id?w=`, made by sharp, kept by the service worker

Date: 2026-10-05. Status: accepted (B-738). Work record: `docs/progress/image-speed.md`. Probes:
`tools/probes/image-cache/`.

## Context

B-738: pictures load slowly, even the second time. Imported phone photos are stored and served at
full size (3-4 MB, 12 MP), there were no smaller copies, and the owner's Mac reaches its server
at about 1.6 MB/s over the tailnet: one page with three photos is ~8 s.

The "even the second time" part had a separate cause, found first (`probe.mjs`, a real
WKWebView with a persistent data store, as Tauri's wry uses): while the app's service worker
controls the page, WKWebView sends every picture request to the network again on every showing
(in-app Back, reload, a second window, a relaunch), although `/assets/:id` is `immutable` and the
same URL on a page with no service worker is served from cache. The worker had a CacheFirst rule
for `/assets/`, but as a RegExp it never matched (B-401), so the worker let every picture
through, and WebKit's pass-through does not consult the HTTP cache. Chromium does, which is why
a desktop browser never showed it.

## Decision

1. **The service worker keeps the graph's pictures** (`apps/web/vite.config.ts`): two CacheFirst
   rules with function matchers, for same-origin `/assets/` requests whose `destination` is
   `image`: `asset-variants` (`?w=` URLs, up to 1000 entries, 90 days) and `asset-originals` (the
   viewer's, up to 60, 30 days), both `purgeOnQuotaError`. Only `image` requests: a video or
   audio asset is fetched with Range requests a CacheFirst would answer with the whole body, and
   Download's `fetch()` goes to the network. Only 200s are stored (workbox's default), so a
   missing asset is asked again.

2. **`GET /assets/:id?w=<w>` answers a resized WebP**, `w` one of `ASSET_VARIANT_WIDTHS` = 480,
   960, 1600 (`@nooklet/core`). Any other `w` is a 400, not rounded: the set of files on disk and
   of URLs in caches stays fixed. Made on the first request (two at a time at most), written to
   `<data>/assets/.thumbs/<id>-<w>.webp` (temp file + rename), read from there afterwards. Same
   headers as the original (immutable, `nosniff`, CSP `sandbox`). The EXIF orientation is applied
   (`autoOrient`), since the variant carries no EXIF. The **original's bytes** answer instead when
   there is nothing to gain or nothing can be made: not JPEG/PNG/WebP (SVG, GIF, PDF…), an
   animated WebP, a picture no wider than `w`, bytes that do not decode, or sharp not loading.
   `backup` leaves `.thumbs/` out; asset GC removes an orphan's variants with it.

3. **Under the same route, the same auth.** B-737 (asset URLs need no token) is undecided; a
   variant is the same resource at another size, so whatever scheme B-737 settles on covers both
   without a second decision.

4. **The client asks for the width it draws** (`apps/web/src/editor/render/image-variant.ts`,
   `ImageView.tsx`): the CSS width the box gives the picture (the column, a chosen `{:width N}`
   from B-789, or the picture's own size capped at 70vh, as the box style computes it) times
   `devicePixelRatio`, rounded up to the next variant; past 1600 by more than 25 % (a picture
   drawn over 2000 device px wide), the original. The `<img>` gets its `src` a microtask after
   mount, once the column is measured, so no guessed width is fetched first; the choice only
   grows (a wider window, a bigger drag) and never switches to a smaller copy already covered. A
   `?w=` URL is used even when the picture may be narrower than `w` (the server then answers the
   original): its size can arrive after it started loading, and switching URLs would fetch it
   twice. The viewer, Download, Copy and Open in new tab keep the original. `loading="lazy"`
   (already there) and `decoding="async"`.

5. **sharp (libvips), native, not a WASM codec.**

## Why sharp, and what it costs to ship

The server ships as one esbuild-bundled `server.mjs` with no `node_modules`, in the desktop
sidecar and in the container image (`deploy/docker/Dockerfile` runs the same
`apps/desktop/build-sidecar.mjs`). A native module therefore has to be shipped beside it, as
`vec0` (sqlite-vec) and `esbuild` already are.

Measured (`tools/probes/image-cache/codec-bench.mjs`, 12 MP JPEG, M-series Mac):

| | 480 | 960 | 1600 | memory |
|---|---|---|---|---|
| sharp 0.35 | 44-50 ms | 77-80 ms | 169-170 ms | libvips streams, shrink-on-load |
| @jsquash (mozjpeg + squoosh resize + libwebp, WASM) | 220-231 ms | 299-356 ms | 496-548 ms | RSS 1038 MB after the run |

The WASM pipeline is 3-5x slower, runs on the main thread (a half-second synchronous decode
stalls every other request, sync included, unless it goes into a worker thread: a second bundle
entry and its own lifecycle), keeps its grown heap, decodes at full size every time (no
shrink-on-load), and leaves EXIF orientation to us. wasm-vips would avoid the last two but is a
much larger module that needs threads. sharp does it off the event loop on libuv's pool.

What shipping sharp takes, done in this change:

- `build-sidecar.mjs` keeps `sharp` external and copies `sharp`, its three JS dependencies and
  the installed `@img/sharp-<platform>` + `@img/sharp-libvips-<platform>` flat into
  `sidecar/lib/node_modules/` (+20 MB on macOS arm64), then checks the copy loads on its own. The
  bundle's banner sets `NOOKLET_SHARP_PATH` to its entry. Tauri copies resource directories
  recursively (`tauri-utils` `resources.rs`, plain `WalkDir`), `node_modules` included.
- `tools/ci/desktop-bundle.sh` signs the `.node` and `.dylib` with the release identity (library
  validation, notarization).
- The container image needs no Dockerfile change: built for `linux/arm64` and `linux/amd64`
  (QEMU) on 2026-10-05, each answered `?w=960` with a 960-px WebP inside the container.
- `tools/probes/image-cache/sidecar-variants.mjs` runs a built sidecar copied out of the repo.

Costs and limits:

- **x86-64 needs the v2 microarchitecture** (SSE4.2, 2009+): sharp's prebuilt Linux x64 binary
  refuses older CPUs (`dist/sharp.mjs`: "Prebuilt binaries for Linux x64 require v2
  microarchitecture"). On such a machine sharp does not load and every picture is served at full
  size — slower, not broken.
- Prebuilt for darwin x64/arm64, linux x64/arm64 (glibc and musl), win32 x64/arm64. A platform
  without one gets originals.
- The disk cache is bounded by the asset count × 3 widths (a 1600-px WebP of a photo is typically
  100-300 kB); nothing evicts it but asset GC.
- An unauthenticated client that knows asset ids can make the server decode each picture up to
  three times (once per width; then it is cached). Bounded, and no worse than downloading the
  originals, but it is CPU on demand; B-737 decides who may ask at all.
- HEIC (iPhone's own format) is not decoded by the prebuilt libvips; such assets are served
  as they are, as before.

## Rejected

- **WASM codecs** (above).
- **Thumbnails made at upload/import**: an import of a few thousand photos would pay for every
  width of every picture up front, most never shown; and existing graphs would need a backfill.
  On demand costs one generation per picture actually seen.
- **Free-form `w`, or `w` rounded to the nearest allowed**: unbounded files, or several URLs for
  one file splitting every cache.
- **`srcset`/`sizes`**: `sizes` would restate in a media-query string what layout decides, and
  with the picture's size unknown a `w` descriptor also sets the displayed size.
- **Content negotiation (`Accept: image/avif`)**: needs `Vary: Accept`, which caches handle poorly,
  for a format every engine this app runs in (WebKit since Safari 14, Chromium) already takes as
  WebP.
- **Only fixing the service worker**: the second showing becomes free, the first still costs
  12 MB per three photos.

## Measured

`tools/probes/image-cache/probe.mjs`, three 12 MP photo-shaped JPEGs (12.2 MB) on one page,
1.6 MB/s link, requests and bytes counted at the server:

| | before | after |
|---|---|---|
| WKWebView, first visit | 3 req, 12.15 MB, 8.0 s | 3 req, 0.38 MB, 0.8 s (2x display: 1600 px) |
| WKWebView, in-app Back / reload / 2nd view / relaunch | 3 req, 12.15 MB, 7.8-8.2 s each | 0 requests |
| Chromium (1x), first visit | 3 req, 12.15 MB, 7.9 s | 3 req, 0.05 MB, 0.5 s (960 px) |

These generated photos compress better than real ones; a real phone photo's 1600-px WebP is
nearer 150-300 kB, so a real first visit is nearer 0.5-1 MB than 0.4.

## Not verified

- The Capacitor (iPhone) shape: a page on `capacitor://localhost` showing `https://` pictures.
  The macOS harness could not load an `<img>` from a scheme-handler page at all (fetch worked), so
  its caching was not measured. The iPhone app has no service worker, so cause 1 does not apply
  there; variants do.
- A Developer-ID-signed, notarized build with the sharp libraries in it (no identity exists yet,
  as for `vec0.dylib`).
- Windows: the sidecar build copies whatever `@img/sharp-win32-*` pnpm installed; not run.
