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

### B-180 (existing)

**Reproduced 2026-09-13** before fixing: built the sidecar at `9402f31` (`node
apps/desktop/build-sidecar.mjs`), copied it out of the repo into an app-bundle layout and started it
the way `main.rs` does on a scratch graph: `GET /api/v1/plugins` answered `{"plugins":[]}`,
`page.wordcount` 404, 29 MCP tools and no `page_wordcount`. Shipping the `plugins/` sources would
not have been enough: the loader bundles a plugin at startup, resolving `@nooklet/plugin-api` and
`zod` through the server's `node_modules` (a bundled server has none) and writing
`.nooklet-build/` into the plugin's directory (inside the signed app; read-only when the app runs
from its disk image). Loading the packaged plugins from a read-only directory the ordinary way left
word-count in `error` (checked with a throwaway copy of the test below).

**Fixed 2026-09-13.** The built-ins ship already bundled, and the host takes them as they are.
`packages/server/src/plugins/bundled.ts#packageBundledPlugins` bundles each built-in's halves with
the loader's own `bundleServerEntry` / `bundleClientEntry` into `<out>/<name>/server.mjs` /
`client.js` plus a `package.json` pointing at them; `build-sidecar.mjs` step 6 runs it (through
`tsx`'s `tsImport`) into `sidecar/plugins/`, and fails the build if word-count is missing.
`server.mjs`'s banner sets `NOOKLET_BUNDLED_PLUGINS_DIR` (unless already set) to the `plugins/`
beside it, so `main.rs` needed no change; `cli.ts#pluginDirsFor` uses that directory instead of the
repo's `plugins/` when the variable is set, for `serve` and `plugin list|enable|disable`.
`PluginHostDeps.bundledDirs` (`createAppWithPlugins`'s `bundledPluginDirs`) marks such directories:
their entries are imported and served through `bundler.ts#alreadyBundled` — hashed, never
re-bundled, nothing written. Cost: the sidecar grows by ~13 MB (word-count's server half 1 MB with
zod inlined; mermaid's client half 12 MB, which the web build also carries — the desktop web app
compiles the client halves in and fetches none of these; shipped so Settings → Plugins lists the
same three plugins with the same halves as `nooklet serve`). **Tests that would have caught it:**
`packages/server/src/plugins/bundled.test.ts` (packages the repo's plugins, makes the output
read-only, loads it from outside any `node_modules`: all three active with the same halves, no
`.nooklet-build`, `page.wordcount` answers, word-count's client half served at its listed URL) and
the re-runnable end-to-end check `tools/probes/sidecar-plugins.mjs` (a built sidecar, copied
read-only to a temp app layout, started from `/`: before, 4 of 4 checks failed; after, 4 of 4 —
three plugins listed, `page.wordcount` 200 with the right count, `page_wordcount` among 30 MCP
tools, client half 200). The full Tauri app was not built; `tauri.conf.json` maps the whole
`../sidecar` directory as a resource, so `plugins/` rides along by reading, not by a built `.app`.

### B-333 · `packages/core`'s performance and sync property tests fail under heavy machine load
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, final `pnpm -r
test` · **Test:** the tests themselves

With load average 62–84 on the shared machine, `pnpm -r test` stopped at `packages/core`, and a
rerun of that package alone failed the same four: `src/tokens.test.ts` "stays far away from
quadratic" (1,488 ms against its 500 ms budget) and three in `src/sync/sync.property.test.ts` —
"dense adversarial moves on a small block pool…" (timed out at 30 s), "converges regardless of
interleaving…" and "content and each prop key converge independently…" (5 s each). This branch
changes nothing in `packages/core` (`git diff cf08d19 -- packages/core` is empty). Not rerun on a
quiet machine; not investigated. A wall-clock budget and fixed per-test timeouts are the likely
reason — the property tests' run counts, not their assertions, would be what to look at. The same
package passed 393/393 minutes later at load average 26.

### B-334 · `SearchView.test.tsx` fails under load: its first test imports the view cold
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, full `apps/web` run at
load average ~70 · **Test:** `apps/web/src/views/SearchView.test.tsx` (the file itself)

Two tests failed in one full run ("a task marker searches blocks with that marker…" and "shows a
hint and does not search before anything is typed"); the failure output was not captured, and a
second full run at load ~40 passed. Alone at load 46 the first test took 2,201 ms and the others
2–311 ms: `renderSearch()` did `await import("./SearchView.js")` inside the test, so the first
test paid the cold import within its 5 s — the B-144 pattern. This branch had just given
`SearchView.tsx` two more imports (`describeError`, `routes/page-path.ts`), which can only have
made that import heavier.

**Fixed 2026-09-13.** The view is imported statically at the top of the test file, loaded while the
file is collected; the first test then took 33 ms. **Test:** the file itself — believed fixed on
the timing evidence, not on a reproduced failure. `JournalStreamView.test.tsx` imports its view
the same way inside a helper; not seen failing, left as it is.

### B-335 · `editing.spec.ts`'s `openJournal` can wait 30 s to blur a journal draft that has already become an outline
**Status:** needs-repro · **Severity:** low (test harness) · **Found:** 2026-09-13, m9 cleanup, e2e
run of the first 38 specs (alphabetical) on port 6405 at load average ~40 · **Test:** the spec
itself

"types a whole sentence into a bullet without editing dying" and "Enter creates a second bullet and
both keep their text" failed with `locator.blur: Test timeout of 30000ms exceeded … waiting for
locator('.vr-draft-input').first()` (`editing.spec.ts:29`): `openJournal` saw a virtual draft,
`fill`ed it, and by the time it blurred, the draft had been swapped for the real outline (or was
never the only journal day on screen — earlier specs leave other days in the shared server's
stream). The same spec alone right after: 5/5. Same family as B-233 (specs sharing today's journal
on one server); nothing in this branch touches the journal views. Likely fix, as B-233 says: give
these tests their own page, or wait for the outline instead of blurring the draft.

