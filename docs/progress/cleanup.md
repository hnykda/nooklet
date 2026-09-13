# cleanup: what the M8 integration skipped (m9)

Branch `m9/cleanup` from `cf08d19`, worktree `.claude/worktrees/wf_e473942f-106-10`. e2e port
**6405**. Scratch: `<scratchpad>/m9/cleanup/` (NOOKLET_DATA and any real-graph copy live there).
Bugs go to `docs/bugs-inbox/cleanup.md` (new numbers B-330..B-339 only), never `docs/BUGS.md`.

Brief, four parts:

1. Redo `3d73b13` (m8/rv-web-security, not merged) on the merged tree: `apiClient` through
   `callOp` (one POST path), one `undoBatch` helper for History / Find & Replace / References /
   refactors, `describeError` wherever a server error is shown.
2. Redo `373c654`: page route paths from one module (`routes/page-path.ts`) so a namespace's "/"
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
  saw failing at `da85cfb`. It fails at `cf08d19` too (1/1, `git switch --detach cf08d19`): it is
  B-161 (logged five times already), not caused here; not logged again.
- Part 1 commit `6812379`.
- Part 3 / B-144 (commit "test(web): load the module a flaky first test waited on…"): both test
  files import the slow module statically (loaded at collection, no timeout). Probe: copies with
  the budget cut below the cold cost failed 3/3 cold, passed 3/3 warm. Web unit 1015/1015.
- Part 3 commit `a9ea71a`.
- Part 2 / B-331 + B-332 (commit "refactor(web): page paths from one module…"): probe spec
  `e2e/tests/namespace-paths.spec.ts` (9 ways into a page) on `a9ea71a`: 5 failed — hrefs with
  `%2F` from six render sites (tokens.tsx ×3, QueryFenceView, EmbedView ×2), shown on the page,
  in references and on the shelf; and Alt+Enter went to the lowercased key (B-332). Every URL
  after navigation was otherwise right. Fix: `routes/page-path.ts` (as `373c654`), all twelve
  inline sites and all importers moved to it, `hosts.ts#pagePath` gone, `followLink` uses the
  name as written. Tests: `page-hrefs.test.tsx` 6/6 failed before; `hosts.test.ts` page links
  2/2 failed before; guard in `source-guards.test.ts` failed before (checked by restoring the
  pre-fix sources and re-applying the patch). Web unit 1024/1024; typecheck clean; e2e
  namespace-paths+navigation+pages+query+shelf+rendering+render+history+trash+refactor+
  follow-link+embeds+tagged-pages+references+views+page-rename+page-identity+plugins+
  untrusted-content 151/151 (views.spec.ts:461 passed this time).

## In flight

- nothing uncommitted.

## Next steps, in order

1. Part 4 (B-180): sidecar ships built-in plugins; build sidecar, start with scratch NOOKLET_DATA,
   check `page.wordcount` exists and a plugin client bundle is served.
2. Final: `pnpm -r test`, progress + return.

## Decisions

- The one `undoBatch` lives in `refactor-api.ts` (as `3d73b13` put it), carrying History's richer
  signature from the merged tree; Find & Replace and References still call it without options
  (no behaviour change for them).
- `describeError` also in ConnectView, GraphMismatchView and PluginFence, whose errors are not
  server errors: `describeError` is identical to `err instanceof Error ? err.message : String(err)`
  for those, and a guard with no exceptions is simpler than an allowlist.
- `biome check` reports 4 errors in `views/DiagnosticsPanel.tsx` lines 62-64 (a11y suppressions in
  a JSX comment) — present at `cf08d19` unchanged (checked by swapping the base file in); not
  touched here.

## How to resume

`git log --oneline cf08d19..m9/cleanup` shows what landed; this file says what each commit covers.
