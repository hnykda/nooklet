# Bug inbox — m9/cleanup

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator.

### B-330 · A search or graph that cannot reach the server does not say where it tried, and several views drop the server's hint
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup (review finding F8 of
`m8/rv-web-security`, whose fix `3d73b13` was not merged) · **Test:** `data/api-client.test.ts`, `views/server-errors.test.tsx`, `source-guards.test.ts`

Two ways to call a server op existed in `apps/web`: `callOp` (network failures become an
`ApiError` naming the address it tried; a rejection keeps the server's `hint`) and
`api-client.ts#createApiClient`'s private `post()`, used by `search`, `page.backlinks` and
`graph.links`, with no network wrapping. So the Search view said "Could not reach the server." (its
own regex over "Failed to fetch") and the Graph view "TypeError: Failed to fetch", where Settings
says which address it tried. Separately, the views that show a failure each formatted it their own
way — `errorText` in Search and Find & Replace, `String(err)` in Graph / Diagnostics / Settings,
`err.message` in History, Trash and the refactor alerts — and every one of those drops the
server's `hint` (`graph.replace`'s "fix the pattern, or set regex: false…"). And `batch.undo` had
three wrappers: `history.ts#undoBatch`, `refactorApi.undoBatch`, and an inline `callOp` in
`ReferencesPanel`.

**Fixed 2026-09-13.** Redoes `3d73b13` on the merged tree. `apiClient` is an object whose three
methods call `callOp` (`post`, `createApiClient` and `ApiClientOptions` are gone; `page.backlinks`
keeps its B-253 cursor walk). `refactor-api.ts#undoBatch` is the one `batch.undo` wrapper, with
History's `keepLaterEdits` / `ignoreBatches` / `kept` (B-251) moved there from `history.ts`;
`refactorApi.undoBatch` and `ReferencesPanel`'s Undo are that function. Every view that shows an
error renders it with `describeError` — Search, Find & Replace, History (Undo, Restore), Trash,
Graph, Diagnostics, Settings, the refactor alerts, and the three whose errors are not server ones
(Connect, graph mismatch, a plugin fence), so the rule has no exceptions to remember. **Tests that
would have caught it:** `apps/web/src/data/api-client.test.ts` (7 of 10 failed before: the network
cases for `search` / `page.backlinks` / `graph.links` / `batch.undo`, and the three through the shared undo
wrapper), `apps/web/src/views/server-errors.test.tsx` (3 of 3 failed
before: Find & Replace hint, Search address, History Undo hint), and the guard
`apps/web/src/source-guards.test.ts` (2 of 2 failed before: a hand-rolled formatter in a UI file,
`"batch.undo"` outside `refactor-api.ts`).

### B-144 (existing)

**Fixed 2026-09-13.** Both tests spent their own timeout loading a module cold: `page-title.test.ts`'s
first `vi.resetModules()` + `import("./page-title.js")` (the first test measured 609–724 ms here,
every later one 1–3 ms), and `render-seams.test.tsx`'s first query fence, whose `lazy()`
`import("./QueryFenceView.js")` had to transform the view and its imports inside `waitFor`'s 1 s.
Each file now imports that module statically, so it is loaded while the file is collected, where no
timeout runs; the tests then wait on a cached module (3 ms). Evidence that this removes the load
dependency rather than widening a margin: copies of both tests with the budget cut below the cold
cost — a 150 ms test timeout for the page-title test, an 8 ms `waitFor` for the fence — failed 3 of
3 runs cold and passed 3 of 3 with the static import (probe copies deleted after; numbers only).
**Test:** the two tests themselves, `apps/web/src/data/page-title.test.ts` "renders a journal by its
day and an ordinary page by its name" and `apps/web/src/editor/render/render-seams.test.tsx` "says
what is wrong, and where, for a query that does not parse". `embed.test.tsx` already works around the
same lazy-chunk cost with a 5 s `waitFor`; left as it is.

