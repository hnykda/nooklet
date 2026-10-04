# mermaid-lazy — mermaid out of the PWA precache; desktop sidecar reuses the web build's copy

Status: **done** (both parts committed). Branch: `worktree-agent-a585a35147c7628f5`
(fast-forwarded to main `c28097a` first: the worktree had been created 634 commits behind).

## Baseline (main `c28097a`)
- Web (`node tools/probes/web-build-weight.mjs`): precache 222 entries, 8026.3 KiB.
- Sidecar (`du -sk apps/desktop/sidecar`): 185,524 KiB; `plugins/mermaid/client.js` 12,032,014 B.
- `nooklet.app` (`tauri build --bundles app`, sum of file sizes): 186,603,034 B (du 182,908 KiB).

## Done
1. `183b058` — `apps/web/vite.config.ts`: a build plugin finds the chunks only reachable through
   mermaid's dynamic import (`apps/web/src/sw/lazy-only-chunks.ts` + unit test); workbox
   `manifestTransforms` drops them from the precache; a function-matcher runtime rule (B-401:
   RegExp rules anchored at `^\/` never match, workbox tests them against the full href) caches
   `/static/*` on first use in cache `lazy-chunks`.
   - After: precache 108 entries, 3006.4 KiB (114 mermaid chunks, ~5 MB, out). JS on disk unchanged.
   - `e2e/tests/mermaid-lazy-cache.spec.ts`: sw.js lists no mermaid chunk (with a positive control);
     diagram rendered once → chunk in `lazy-chunks` cache → offline reload renders it again.
   - Negative checks run: with the rule as RegExp `/^\/static\//` the cache assertion fails; with
     the cache assertion removed too, the offline render fails. So both steps are load-bearing.
2. `8f637ba` — sidecar: `packageBundledPlugins(..., { clientImportUrls })` →
   `bundleClientEntry(..., importUrls)` resolves `mermaid` to the web build's
   `/static/mermaid.core-<hash>.js` as an external URL import. `build-sidecar.mjs` finds that chunk
   in `sidecar/web/static`, and fails the build if the packaged mermaid client.js exceeds 512 KiB.
   - Why it was bundled there: `nooklet serve`'s `/plugins/<id>/client.<hash>.js` route for
     plugin client halves (ADR 007). The sidecar packages built-ins at build time (B-180), so it
     inlined mermaid. The app never requests it (ADR 023 compiles built-in client halves in) —
     the desktop app's diagrams come from `web/`, unaffected.
   - After: sidecar 173,176 KiB (−12,348 KiB); `plugins/mermaid/client.js` 2,452 B;
     `nooklet.app` 174,573,472 B (−12,029,562 B; du 171,160 KiB).
   - `tools/probes/sidecar-mermaid.mjs` (read-only sidecar copy + headless Chromium, no GUI): app
     draws a diagram; the served client half, imported and activated in the page, draws one too
     through the web build's mermaid.core. All checks ok. `tools/probes/sidecar-plugins.mjs` ok.
   - Unit: `bundled.test.ts` "clientImportUrls leaves a mapped specifier as an import of its URL".

## Verification (final tree)
- e2e (port 6306): mermaid-lazy-cache, plugins, mermaid-after-text, render-views,
  render-views-phone, render, rendering, sw-update — 32 passed.
- `pnpm -r test`: core 423, plugin-api 17, server 781, web 1386, desktop 4 — all passed.
- `pnpm -r typecheck` exit 0; `biome check . --diagnostic-level=error` clean. No Rust touched.

## Still unverified
- WebKit / the Mac app's WKWebView: the runtime-cache rule and offline-after-first-use were run in
  Chromium only. WKWebView's service worker support for the app's custom origin was not exercised.
- The first diagram after a client UPDATE needs the network (new chunk hashes); not tested, follows
  from the design.

## BUGS.md updates to fold in
- B-401: append to its body — "2026-10-03 (mermaid-lazy): confirmed in Chromium. A RegExp
  rule `/^\/static\//` never put a chunk in its cache; the function matcher
  `({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/static/")` did
  (`e2e/tests/mermaid-lazy-cache.spec.ts`). The two original rules (`api|sync` NetworkOnly,
  `/assets/` CacheFirst) are untouched and still never match; the `/assets/` one still needs the
  authenticated-response question answered before it is switched to a function."
