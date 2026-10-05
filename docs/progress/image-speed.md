# image-speed — B-738: images load slowly, even the second time (2026-10-05)

Branch: the agent's own worktree branch off `81d8a618`. Not merged, not pushed. e2e port 6540.
New bug numbers from B-900.

## Status

**In flight.** Step 1 (evidence) done; fixing.

1. [done] Probe: why repeat loads are slow → `tools/probes/image-cache/` (findings below).
2. [next] Fix the service worker rule for `/assets/` (B-401's dead CacheFirst rule).
3. [next] Resized variants `/assets/:id?w=480|960|1600`, ADR 035, client `srcset`.
4. [next] `decoding="async"` (`loading="lazy"` is already there).
5. [next] Tests, full suites, after-numbers from the probe, BUGS entries.

## Findings (step 1, measured 2026-10-05)

`node tools/probes/image-cache/probe.mjs`: a real `nooklet serve` + this checkout's production web
build behind a counting proxy throttled to 1.6 MB/s (one shared link); three 3.5 MB noise PNGs on
one page; requests counted AT THE SERVER. Before any fix:

| step | Chromium | Playwright WebKit | real WKWebView (persistent store) | WKWebView, SW API removed |
|---|---|---|---|---|
| 1 first visit | 3 req, 10.5 MB | 3, 10.5 MB | 3, 10.5 MB, 6.9 s | 3, 10.5 MB |
| 2 in-app away + Back | **0** | 3, 10.5 MB | **3, 10.5 MB, 7.6 s** | **0** |
| 3 reload | 0 | 0 | **3, 10.5 MB, 6.8 s** | 0 |
| 4 second tab/view, same store | 0 | 3, 10.5 MB | **3, 10.5 MB, 6.8 s** | 0 |
| R new process, same store | – | – | **3, 10.5 MB, 6.9 s** | 0 |

- **Root cause (Mac app): the service worker.** In WKWebView, while the app's service worker
  controls the page, every `<img>` for `/g/<slug>/assets/<id>` reaches the server again, on every
  showing: in-app Back, reload, a second window, a relaunch. The SW's fetch handler does not
  respond to these requests (workbox finds no matching route: B-401, the `/assets/` RegExp never
  matches `url.href`), and WebKit's fall-through to the network does not use the HTTP cache.
  Removing only the service worker API (a user script `delete Navigator.prototype.serviceWorker`)
  takes every repeat to 0 requests, across a new process too.
- The response headers are not the cause: the same asset URL on a plain control page (no SW) in
  the same WKWebView is served from cache on reload and in a second view; control pictures with
  `cache-control` only / + `nosniff` / + `csp: sandbox` / + validators all cache alike; only a
  control with no `cache-control` is refetched.
- The URL is stable: `assetUrl()` is a pure function of the block text (`apiBaseUrl()` +
  `/assets/<id>.<ext>`), no query, same origin. The component does remount on in-app navigation
  (a new `<img>`), which in Chromium is a memory-cache hit; it is not the cause.
- Chromium is fine as it is (0 repeat requests), so a desktop browser never showed the bug.
- Playwright's WebKit has no disk cache at all (control pictures refetched in a second tab), so it
  cannot stand in for the Mac app here; hence the Swift half, `tools/probes/image-cache/wkwebview.swift`.
- Capacitor shape (page on `capacitor://localhost`, picture on https): NOT measured. In the macOS
  harness, an `<img>` on a WKURLSchemeHandler page was refused before any request was made (no TLS
  connection reached the proxy), while `fetch(…, {mode: "no-cors"})` from the same page worked.
  The service worker cause cannot apply there: Capacitor pages have no service worker
  (`sw/register.ts`, research/08 §1.2). Still unverified on a phone.
- A bare `/assets/<id>` (no `/g/<slug>`) answers 307 to `/g/default/...` (by design,
  `graphs/mount.ts`); the client always uses the prefixed URL, so this costs nothing in the app.

## Decisions

(see ADR 035 once written)

## How to resume

Read this file, then `git log --oneline 81d8a618..`. The probe needs `pnpm --filter @nooklet/web
build` first; `ENGINES=wkwebview SIDE=120 RATE=0` runs the WKWebView half quickly.
