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
  saw failing at `da85cfb`. Checking it against `cf08d19` next.

## In flight

- Is `views.spec.ts:461` failing at `cf08d19` too? `git switch --detach cf08d19`, run that one
  test on port 6405, `git switch m9/cleanup`. If the worktree is found detached, switch back first.

## Next steps, in order

1. Part 3 (B-144).
2. Part 2 (page paths) — probe first.
3. Part 4 (B-180).

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
