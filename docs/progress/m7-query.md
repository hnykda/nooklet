# M7 progress — query fence + render seams (agent: query/render)

Resilience log per the owner's instruction: updated after every meaningful step. If you are
reading this after a restart, continue from **Next steps**.

## Done (commit hashes)

- (uncommitted → see In flight) `packages/core/src/query.ts` + `query.test.ts` (55 tests green):
  parser, matcher, sorter, SQL prefilter for the ```` ```query ```` language. Exported from
  `packages/core/src/index.ts`.
- Installed `highlight.js@11.12.0` and `katex@0.18.7` into `apps/web` (package.json + lockfile).
- Baseline production bundle measured BEFORE any web change (HEAD c9a98f9, built into scratch):
  main chunk `index-*.js` 600.12 kB (gzip 191.11 kB), `index-*.css` 62.96 kB (gzip 10.79 kB),
  PWA precache 19 entries / 1996.78 KiB. Log: scratchpad `build-before.log`.

## In flight (file → state)

- `apps/web/src/data/queries.ts` — written; MUST switch its reactivity from `onChange` (single-slot
  in the worker, would clobber store.ts's listener) to `stampedFor` from `store.ts`.
- `apps/web/src/data/store.ts` — append-only helper `stampedFor` to add (not yet added).
- `apps/web/src/editor/render/QueryFenceView.tsx`, `query.css` — written, untested.
- `apps/web/src/editor/render/highlight.ts`, `highlighter-impl.ts`, `highlight.css` — written, untested.
- `apps/web/src/editor/render/math.ts`, `math-impl.ts`, `math.css` — written, untested.
- `apps/web/src/editor/render/tokens.tsx` — NOT yet edited (fence → QueryFence/CodeFence, math → MathView).
- `apps/web/src/editor/livePreview.ts` — NOT yet edited (KaTeX widget).
- `/query` slash: `commands/registrations/insert-logic.ts` + `insert.ts` + `slash/items.ts` — NOT yet edited.

## Next steps, in order

1. Commit core query language (partial-stage `index.ts`: only the `query.js` line is mine).
2. `store.ts`: append `stampedFor`; `queries.ts`: use it. Edit `tokens.tsx`, `livePreview.ts`.
3. `/query` slash item + command (`insertQueryFence`).
4. Unit tests: `render/highlight.test.ts`, `data/queries.test.ts`, `render/tokens.test.tsx` cases,
   `insert-logic.test.ts` case. `pnpm -r typecheck`, `pnpm -r test`, biome.
5. e2e `e2e/tests/query.spec.ts`, `e2e/tests/render.spec.ts` on port 6350.
6. Build after; record sizes in `docs/research/14-render-seams.md`; amend `docs/adr/011-*.md`.
7. Full e2e on 6350; final report.

## Decisions and why

- **Query language**: ADR 011's compact filter syntax, implemented as: `marker:`/bare `TODO`,
  `priority:`, `tag:`/`ref:`/bare `#x`/`[[x]]`, `page:`, `namespace:`, `journal:`,
  date fields `scheduled/deadline/due/done/created/updated` with `< <= > >= = a..b none any` and
  `today/tomorrow/yesterday/YYYY-MM-DD/±Nd|w|m|y`, `text:`/bare words/"phrases", `prop:k[=v]`,
  `and`/`or`/`not`/`-`/parens, `sort:`, `limit:`. Deferred: ```sql fence, path-refs (ancestor
  inheritance), page-level property/tag queries, Tasks-view/MCP reuse of the parser.
- **Evaluation**: SQL prefilter (necessary condition, 3-valued-logic-safe) + JS exact match, all
  on the local replica — no `ref` table on the client, so tags need `extractRefs` in JS.
- **Highlighter**: highlight.js core + per-language lazy chunks (no WASM, tiny grammars) over
  shiki/lowlight/CM lang packs. **Math**: KaTeX (sync render needed for the CM6 widget) over MathJax.
- **Reactivity**: cannot subscribe to the worker bus twice; use store.ts's stamping idiom via an
  appended `stampedFor` helper.

## How to resume

- e2e: `cd e2e && NOOKLET_E2E_PORT=6350 pnpm exec playwright test tests/query.spec.ts tests/render.spec.ts`
- unit: `cd packages/core && pnpm exec vitest run src/query.test.ts`; `cd apps/web && pnpm exec vitest run`
- scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`
  (`dist-before/`, `build-before.log`). Build "after" the same way with `--outDir <scratch>/dist-after`.
- Commit trailer (exact):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` /
  `Claude-Session: https://claude.ai/code/session_014zmrHaeuokBDD83XdybrJ` — see task text for the
  exact session URL (copy from there, not from here).
