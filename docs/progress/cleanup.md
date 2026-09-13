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

- (nothing yet)

## In flight

- Reading the two reference commits against the merged tree.

## Next steps, in order

1. Part 1 (api-client) — log B-330, tests, fix, commit.
2. Part 3 (B-144).
3. Part 2 (page paths) — probe first.
4. Part 4 (B-180).

## Decisions

## How to resume

`git log --oneline cf08d19..m9/cleanup` shows what landed; this file says what each commit covers.
