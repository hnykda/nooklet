# mermaid-lazy — mermaid out of the PWA precache; desktop sidecar reuses the web build's copy

Branch: `worktree-agent-a585a35147c7628f5` (fast-forwarded to main `fd779f4` first: the worktree
had been created 634 commits behind).

## Baseline (main `fd779f4`, `node tools/probes/web-build-weight.mjs`)
- precache: 222 entries, 8026.3 KiB; js on disk 193 files, 6817.3 KiB.

## Done
1. `apps/web/vite.config.ts`: a build plugin finds the chunks only reachable through mermaid's
   dynamic import (`apps/web/src/sw/lazy-only-chunks.ts` + unit test); workbox
   `manifestTransforms` drops them from the precache; a function-matcher runtime rule (B-401:
   RegExp rules anchored at `^\/` never match, workbox tests them against the full href) caches
   `/static/*` on first use in cache `lazy-chunks`.
   - After: precache 108 entries, 3006.4 KiB (114 mermaid chunks, ~5 MB, out). JS on disk unchanged.
   - `e2e/tests/mermaid-lazy-cache.spec.ts`: sw.js lists no mermaid chunk (with a positive control);
     diagram rendered once → chunk in `lazy-chunks` cache → offline reload renders it again.
   - Negative checks run: with the rule as RegExp `/^\/static\//` the cache assertion fails; with
     the cache assertion removed too, the offline render fails. So both steps are load-bearing.
   - plugins, mermaid-after-text, render-views(-phone), render, rendering, sw-update + new: 32 passed.

## Next
2. Sidecar: bundle the mermaid plugin's client half with `mermaid` external, pointed at the web
   build's `static/mermaid.core-*.js`, instead of inlining a second ~12 MB copy.

## BUGS.md updates to fold in
- B-401: append to its body — "2026-10-03 (mermaid-lazy): confirmed in Chromium. A RegExp
  rule `/^\/static\//` never put a chunk in its cache; the function matcher
  `({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/static/")` did
  (`e2e/tests/mermaid-lazy-cache.spec.ts`). The two original rules (`api|sync` NetworkOnly,
  `/assets/` CacheFirst) are untouched and still never match; the `/assets/` one still needs the
  authenticated-response question answered before it is switched to a function."
