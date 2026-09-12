# M7 progress — query fence + render seams (agent: query/render)

Resilience log per the owner's instruction: updated after every meaningful step. If you are
reading this after a restart, continue from **Next steps**.

## Done (commit hashes)

- `f1675df` feat(core): the ```query fence language — `packages/core/src/query.ts` +
  `query.test.ts` (55 tests): parser, matcher, sorter, SQL prefilter.
- `0b69dc0` feat(web): render seams — highlight.js (lazy, per-language chunks) + KaTeX (lazy),
  `tokens.tsx`/`livePreview.ts` wired, `e2e/tests/render.spec.ts`, package.json + lockfile.
- `dfaf3b9` feat(web): query fence UI — `data/queries.ts`, `store.ts` `stampedFor`,
  `render/QueryFenceView.tsx`, `/query` command + slash item, `e2e/tests/query.spec.ts`.
- `36bc2cb` fix(core): TS narrowing in the parser (HEAD typecheck was red), biome formatting,
  e2e seed fix.
- Unit: 86 web tests + 55 core tests green. e2e `query.spec.ts` + `render.spec.ts`: **14/14 pass**
  on a clean checkout of `dfaf3b9` (+ the fixed spec) on port 6350. In the shared working tree
  the same run rendered a blank app (no `.vr-row` anywhere, even on a plain page) — other
  agents' uncommitted files at that moment, not committed code.
- Bundle numbers (clean worktrees, exact commits) in `docs/research/14-render-seams.md`.
- ADR 011 amended (language as shipped, semantics, deferrals).

- `28fcb7c` docs: ADR 011 amendment + `docs/research/14-render-seams.md`.
- `a2d5c13` docs(bugs): B-94 (midnight staleness), B-93 cross-reference.
- `pnpm -r typecheck` exit 0; `pnpm -r test` 1,539 tests green (shared tree, 2026-09-12 ~18:10).
- Full e2e on the shared tree, port 6350, in three shards (`scratch/e2e-shard1b.log`, `-shard2.log`,
  `-shard3.log`): 280 passed, 6 failed, 3 skipped. Failures: `context-menu:219` (refactors
  agent's uncommitted menu entries), `templates:202` (templates agent), `journals:73` and
  `render:36` (`browserContext.close: ENOENT …/test-results/.playwright-artifacts-*` — the
  repo-root artifacts dir is shared by every agent's concurrent Playwright run; assertions had
  passed), `navigation:38` (401 from `window.__NOOKLET__.token`), `selection:121`
  (`toBeFocused`). Re-check of render/query/navigation/selection: `scratch/e2e-recheck.log`.
- Lesson recorded: never `kill` port 6350 while a background run may still own it — the state
  file is keyed by port, so two runs on one port kill each other's server (that is what produced
  the connection-refused walls in `e2e-full.log` and `e2e-shard1.log`).

## In flight (file → state)

- Nothing mid-edit. All owned files committed.

## Next steps, in order

1. Final report to the owner (see the task text for the required sections).

## Decisions and why

- **Query language**: ADR 011 amendment has the full table. Deferred: ```sql fence, path-refs,
  page-level queries, Tasks-view/MCP reuse of the parser, `$$` display math, midnight refresh.
- **Query blocks are never results** (a `text:work` fence would list itself).
- **Evaluation**: SQL prefilter (necessary condition, 3-valued-logic-safe) + JS exact match, all
  on the local replica — no `ref` table on the client, so tags need `extractRefs` in JS.
- **Highlighter**: highlight.js core + per-language lazy chunks over shiki/lowlight/CM lang packs.
  **Math**: KaTeX (sync render needed for the CM6 widget) over MathJax. Numbers in research/14.
- **Reactivity**: the worker change bus is single-slot (`worker-core.ts onChange`), owned by
  `store.ts`; `queries.ts` uses an appended `stampedFor` helper there rather than subscribing.

## How to resume

- e2e: `cd e2e && NOOKLET_E2E_PORT=6350 pnpm exec playwright test tests/query.spec.ts tests/render.spec.ts`
  (if the shared tree renders blank, run from a clean worktree of HEAD:
  `git worktree add <dir> HEAD && cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts`).
- unit: `cd packages/core && pnpm exec vitest run src/query.test.ts`;
  `cd apps/web && pnpm exec vitest run src/editor/render src/data/queries.test.ts src/commands/registrations/insert-logic.test.ts`
- scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`
  (`measure.sh`, `measure.log`, `wt-before/`, `wt-after/`, `e2e-full.log`, `typecheck.log`, `unit.log`).
- Commit trailer: exactly the two lines given in the task text (Co-Authored-By + Claude-Session).
