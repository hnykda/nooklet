# M7 progress — query fence + render seams (agent: query/render)

Resilience log per the owner's instruction: updated after every meaningful step. If you are
reading this after a restart, continue from **Next steps**.

## Done (commit hashes)

- `f1675df` feat(core): the ```query fence language — `packages/core/src/query.ts` +
  `query.test.ts` (55 tests green): parser, matcher, sorter, SQL prefilter.
- Installed `highlight.js@11.12.0` and `katex@0.18.7` into `apps/web` (package.json + lockfile) —
  uncommitted until the render-seams commit below.
- Baseline production bundle measured BEFORE any web change (HEAD c9a98f9, built into scratch):
  main chunk `index-*.js` 600.12 kB (gzip 191.11 kB), `index-*.css` 62.96 kB (gzip 10.79 kB),
  PWA precache 19 entries / 1996.78 KiB. Log: scratchpad `build-before.log`.
- Web side written and unit-tested (67 tests green in `render/`, `data/queries.test.ts`,
  `insert-logic.test.ts`); typecheck clean for my files (remaining web TS errors are other
  agents' `refactor-host.tsx` / `VirtualJournalDay.test.tsx`).

## In flight (file → state)

- Commit A (render seams): `render/highlight.ts`, `highlighter-impl.ts`, `highlight.css`,
  `math.ts`, `math-impl.ts`, `math.css`, `tokens.tsx`, `livePreview.ts`, `highlight.test.ts`,
  `render-seams.test.tsx`, `apps/web/package.json`, `pnpm-lock.yaml`, `e2e/tests/render.spec.ts`.
- Commit B (query fence UI): `data/queries.ts` + test, `data/store.ts` (append-only `stampedFor`),
  `render/QueryFenceView.tsx`, `query.css`, `commands/registrations/insert-logic.ts` (+test),
  `insert.ts`, `slash/items.ts`, `e2e/tests/query.spec.ts`.
- e2e specs written, NOT yet run.

## Next steps, in order

1. Run `cd e2e && NOOKLET_E2E_PORT=6350 pnpm exec playwright test tests/query.spec.ts tests/render.spec.ts`;
   fix what fails; commit.
2. Build "after" into scratch `dist-after`; write `docs/research/14-render-seams.md` with before/after.
3. Amend `docs/adr/011-*.md` (language as shipped, deferrals, why).
4. Log any bugs found in `docs/BUGS.md` (re-read right before editing; next free number).
5. Full e2e on 6350, `pnpm -r typecheck`, `pnpm -r test`, biome on my files. Final report.

## Decisions and why

- **Query language**: ADR 011's compact filter syntax: `marker:`/bare `TODO`, `priority:`,
  `tag:`/`ref:`/bare `#x`/`[[x]]`, `page:`, `namespace:`, `journal:`, date fields
  `scheduled/deadline/due/done/created/updated` with `< <= > >= = a..b none any` and
  `today/tomorrow/yesterday/YYYY-MM-DD/±Nd|w|m|y`, `text:`/bare words/"phrases", `prop:k[=v]`,
  `and`/`or`/`not`/`-`/parens, `sort:`, `limit:`. Deferred: ```sql fence, path-refs (ancestor
  inheritance), page-level property/tag queries, Tasks-view/MCP reuse of the parser.
- **Query blocks are never results** (a `text:work` fence would list itself).
- **Evaluation**: SQL prefilter (necessary condition, 3-valued-logic-safe) + JS exact match, all
  on the local replica — no `ref` table on the client, so tags need `extractRefs` in JS.
- **Highlighter**: highlight.js core + per-language lazy chunks (no WASM, tiny grammars) over
  shiki/lowlight/CM lang packs. **Math**: KaTeX (sync render needed for the CM6 widget) over MathJax.
- **Reactivity**: the worker change bus is single-slot (`worker-core.ts onChange`), owned by
  `store.ts`; `queries.ts` uses an appended `stampedFor` helper there rather than subscribing.

## How to resume

- e2e: `cd e2e && NOOKLET_E2E_PORT=6350 pnpm exec playwright test tests/query.spec.ts tests/render.spec.ts`
- unit: `cd packages/core && pnpm exec vitest run src/query.test.ts`;
  `cd apps/web && pnpm exec vitest run src/editor/render src/data/queries.test.ts src/commands/registrations/insert-logic.test.ts`
- scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`
  (`dist-before/`, `build-before.log`). Build "after" with
  `pnpm --filter @nooklet/web exec vite build --outDir <scratch>/dist-after --emptyOutDir`.
- Commit trailer: exactly the two lines given in the task text (Co-Authored-By + Claude-Session).
