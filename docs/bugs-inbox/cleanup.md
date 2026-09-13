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

### B-331 · A rendered link to a namespaced page points at `/page/Area%2FLeaf`, not `/page/Area/Leaf`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup (review finding F9 of
`m8/rv-web-security`, whose fix `373c654` was not merged; re-probed on the merged tree) · **Test:**
`apps/web/src/editor/render/page-hrefs.test.tsx`, `e2e/tests/namespace-paths.spec.ts`,
`apps/web/src/source-guards.test.ts`

Hover, middle-click, "Copy link" or open-in-new-tab on `[[NSPath Area/Leaf Page]]` and the address
is `/page/NSPath%20Area%2FLeaf%20Page`. The page still opens — the route is a splat and the name is
decoded — which is why nobody saw it, but it is not the page's address as the app itself navigates
to it (`/page/NSPath%20Area/Leaf%20Page`), and `pathToPageName` documents that the app never
produces `%2F`. Probed with `e2e/tests/namespace-paths.spec.ts` on `a9ea71a`, every way into a
page: the `href` of a `[[link]]`, a `#[[tag]]`, a `[label]([[page]])`, a query result's page heading
and an embed's source line all carried `%2F` (six render sites: three in `editor/render/tokens.tsx`,
one in `QueryFenceView.tsx`, two in `EmbedView.tsx`, each `encodeURIComponent` over the whole
name), and so did every screen showing one of those links (a page's linked references, the shelf).
The URL after navigating was right everywhere: palette, link click, shelf card, a reference, a
tagged page, the trash and its restore notice, history and its back link, search, all pages.
Page paths were still built inline in twelve places (`hosts.ts` twice plus its own exported
`pagePath`, `Sidebar.tsx` twice, `PageView.tsx`'s history link, and the six above) besides
`views/navigateTarget.ts`, the module that had the functions.

**Fixed 2026-09-13.** Redoes `373c654` on the merged tree. `apps/web/src/routes/page-path.ts` (no
imports, so the renderer does not pull in the data layer) holds `pageNameToPath`, `pathToPageName`,
`pageRoutePath`, `pageZoomRoutePath` and `historyRoutePath`; `views/navigateTarget.ts` keeps only
`goToTarget`; `hosts.ts#pagePath` is gone (the client plugin host gets `pageRoutePath`). All twelve
inline sites and every importer go through it. A bookmarked `%2F` URL still opens the page (the
route decodes its splat) and is not rewritten. **Tests that would have caught it:**
`apps/web/src/editor/render/page-hrefs.test.tsx` (6 of 6 failed before with `%2F`: link, tag,
label, query heading, embed source, embed at the depth limit); `e2e/tests/namespace-paths.spec.ts`
(9 tests, one per way into a page; on `a9ea71a` 5 failed — the rendered hrefs, and the palette and
shelf screens that show them; after, 9/9); the guard in `apps/web/src/source-guards.test.ts`
"are built only by routes/page-path.ts" (failed before, listing the sites).

### B-332 · Alt+Enter on `[[Some Page]]` opens `/page/some page` — the lowercased key, not the name
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, probing B-331 · **Test:**
`apps/web/src/app/hosts.test.ts` "nav.followLink for page links", `e2e/tests/namespace-paths.spec.ts`
"Alt+Enter on a [[namespaced link]] opens it at its path"

Put the caret in `[[NSPath Area/Leaf Page]]` and press Alt+Enter ("Follow link under cursor"): the
page opens, but the address bar reads `/page/nspath%20area/leaf%20page`, while clicking the same
link gives `/page/NSPath%20Area/Leaf%20Page`. The canonical-route effect (B-104) deliberately leaves
a URL that differs from the page's name only in case, so the lowercase URL stays — in the address
bar, Back, a copied link, and the History link's comparisons. `createNavigationHost#followLink`
passed the link through `normalizePageName`, which is the lookup KEY (NFC, whitespace collapsed,
lowercased), not a display name.

**Fixed 2026-09-13.** `followLink` navigates to `pageRoutePath(link.name)` — the name as written,
exactly what a click on the rendered link does. **Tests that would have caught it:**
`apps/web/src/app/hosts.test.ts` "nav.followLink for page links" (2 of 2 failed before) and
`e2e/tests/namespace-paths.spec.ts` "Alt+Enter on a [[namespaced link]] opens it at its path"
(failed on `a9ea71a` with `/page/nspath%20area/leaf%20page`).

