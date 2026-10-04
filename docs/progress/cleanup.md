# cleanup: what the M8 integration skipped (m9)

Branch `m9/cleanup` from `febfc23`, worktree `.claude/worktrees/wf_e473942f-106-10`. e2e port
**6405**. Scratch: `<scratchpad>/m9/cleanup/` (NOOKLET_DATA and any real-graph copy live there).
Bugs go to `docs/bugs-inbox/cleanup.md` (new numbers B-330..B-339 only), never `docs/BUGS.md`.

Brief, four parts:

1. Redo `5d12eaa` (m8/rv-web-security, not merged) on the merged tree: `apiClient` through
   `callOp` (one POST path), one `undoBatch` helper for History / Find & Replace / References /
   refactors, `describeError` wherever a server error is shown.
2. Redo `24ee675`: page route paths from one module (`routes/page-path.ts`) so a namespace's "/"
   is never `%2F`; first probe every navigation path with a namespaced page on the merged tree.
3. B-144: two web unit tests flaky under load (query fence first render, page-title first test).
4. B-180: the desktop sidecar ships no built-in plugins' server halves (`build-sidecar.mjs`);
   verify by building the sidecar and starting it on a scratch NOOKLET_DATA (no Tauri build).

## Done

- Part 1 / B-330 (commit "refactor(web): one POST path for server ops…"): `apiClient` through
  `callOp`; `refactor-api.ts#undoBatch` the one `batch.undo` wrapper (History's options and
  `kept` moved there from `history.ts`); `describeError` in every UI file that shows an error.
  Tests `data/api-client.test.ts` (7/10 failed before), `views/server-errors.test.tsx` (3/3 failed
  before), `source-guards.test.ts` (2/2 failed before). Web unit 1015/1015; typecheck clean; e2e
  views+replace+graph+history+trash+references+link-unlinked+diagnostics+settings+refactor+
  plugins+connectivity+search-filters 95/96 — the one failure is `views.spec.ts:461` (palette
  focus: `.cm-content` "inactive" after Escape), failed on rerun too; same test rv-web-security
  saw failing at `61279a2`. It fails at `febfc23` too (1/1, `git switch --detach febfc23`): it is
  B-161 (logged five times already), not caused here; not logged again.
- Part 1 commit `aa3f350`.
- Part 3 / B-144 (commit "test(web): load the module a flaky first test waited on…"): both test
  files import the slow module statically (loaded at collection, no timeout). Probe: copies with
  the budget cut below the cold cost failed 3/3 cold, passed 3/3 warm. Web unit 1015/1015.
- Part 3 commit `b01970f`.
- Part 2 / B-331 + B-332 (commit "refactor(web): page paths from one module…"): probe spec
  `e2e/tests/namespace-paths.spec.ts` (9 ways into a page) on `b01970f`: 5 failed — hrefs with
  `%2F` from six render sites (tokens.tsx ×3, QueryFenceView, EmbedView ×2), shown on the page,
  in references and on the shelf; and Alt+Enter went to the lowercased key (B-332). Every URL
  after navigation was otherwise right. Fix: `routes/page-path.ts` (as `24ee675`), all twelve
  inline sites and all importers moved to it, `hosts.ts#pagePath` gone, `followLink` uses the
  name as written. Tests: `page-hrefs.test.tsx` 6/6 failed before; `hosts.test.ts` page links
  2/2 failed before; guard in `source-guards.test.ts` failed before (checked by restoring the
  pre-fix sources and re-applying the patch). Web unit 1024/1024; typecheck clean; e2e
  namespace-paths+navigation+pages+query+shelf+rendering+render+history+trash+refactor+
  follow-link+embeds+tagged-pages+references+views+page-rename+page-identity+plugins+
  untrusted-content 151/151 (views.spec.ts:461 passed this time).
- Part 2 commit `0d5d232`.
- Part 4 / B-180 (commit "fix(desktop): the sidecar ships the built-in plugins, bundled…"):
  reproduced first (sidecar built at `0d5d232`, copied out of the repo, started like `main.rs`:
  plugins `[]`, `page.wordcount` 404). Fix: `plugins/bundled.ts#packageBundledPlugins` (the
  loader's own bundler, at build time), `build-sidecar.mjs` step 6 into `sidecar/plugins/` +
  banner setting `NOOKLET_BUNDLED_PLUGINS_DIR`, `cli.ts#pluginDirsFor` honours it,
  `PluginHostDeps.bundledDirs` imports/serves those entries via `bundler.ts#alreadyBundled`.
  Tests: `plugins/bundled.test.ts` 2/2 (loaded as ordinary dirs from the read-only copy: 2/2 fail);
  probe `tools/probes/sidecar-plugins.mjs` before 0/4, after 4/4. Server unit 610/610; typecheck
  clean; e2e plugins+settings 15/15; `nooklet plugin list` in dev still lists the repo's three.
- Part 4 commit `62af37a`.
- Final checks. `pnpm -r test` stopped at `packages/core` at load average 62–84: 4 timing tests
  (tokens perf budget, three sync property timeouts), same 4 on a rerun, then 393/393 at load 26
  — logged B-333 (core untouched here). `apps/web` full run at load ~70 failed 2 SearchView tests:
  the B-144 cold-import pattern, fixed the same way as B-334 (`abe5147`); web 1024/1024 at load
  ~40. Server 610/610, plugin-api 17/17.
- Full e2e in two halves on port 6405 (450 tests incl. the 9 new): 445 passed, 2 skipped, 3
  failed — `views.spec.ts:461` (B-161, fails at `febfc23` too), and two `editing.spec.ts` tests
  blurring a journal draft that had become an outline (logged B-335, same family as B-233; the
  spec alone right after: 5/5).

## In flight

- nothing uncommitted.

## Next steps, in order

- Nothing left in the brief. For the coordinator: fold `docs/bugs-inbox/cleanup.md` (B-330..B-335,
  B-144 and B-180 existing) into `docs/BUGS.md`; owner decision on shipping plugin client halves
  in the sidecar (+12 MB, see Decisions).

## Decisions

- The one `undoBatch` lives in `refactor-api.ts` (as `5d12eaa` put it), carrying History's richer
  signature from the merged tree; Find & Replace and References still call it without options
  (no behaviour change for them).
- `describeError` also in ConnectView, GraphMismatchView and PluginFence, whose errors are not
  server errors: `describeError` is identical to `err instanceof Error ? err.message : String(err)`
  for those, and a guard with no exceptions is simpler than an allowlist.
- B-180: bundle at build time with the loader's own functions rather than a second esbuild
  config in `build-sidecar.mjs`; the env var is set by `server.mjs`'s banner rather than
  `main.rs`, because the banner is what the probe exercises and `main.rs` could not be built here.
  Client halves shipped too (+12 MB for mermaid) so the plugin list matches `nooklet serve` —
  the owner may prefer to drop them (Settings would then show word-count as server-only and omit
  mermaid); a small change in `bundled.ts`.
- `biome check` reports 4 errors in `views/DiagnosticsPanel.tsx` lines 62-64 (a11y suppressions in
  a JSX comment) — present at `febfc23` unchanged (checked by swapping the base file in); not
  touched here.

## How to resume

`git log --oneline febfc23..m9/cleanup` shows what landed; this file says what each commit covers.
