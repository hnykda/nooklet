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

## In flight (file → state)

- Docs commit pending: `docs/research/14-render-seams.md` (new), `docs/adr/011-*.md` (amended),
  this file.
- Background: full e2e suite in `scratch/wt-after` on 6350 → `scratch/e2e-full.log`
  (ends with `E2E_FULL_EXIT=`); `pnpm -r typecheck` → `scratch/typecheck.log`; `pnpm -r test`
  → `scratch/unit.log`.

## Next steps, in order

1. Commit the docs. Log the midnight-staleness limitation in `docs/BUGS.md` (re-read first).
2. Read the three background logs; report failures faithfully (other agents' files vs mine).
3. Final report to the owner (see the task text for the required sections).

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
