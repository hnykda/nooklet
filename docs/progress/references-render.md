# references-render — B-550: linked references render as the block looks in its page

Branch `m11/references-render` from `51830cd`, worktree
`<repo>/.claude/worktrees/wf_3a5c12f3-4ba-1`. e2e port 6423. Scratch (graph copy,
data dir): `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11e/`.

Task: each linked reference / unlinked mention renders like the block in its page, read-only — full
content through the outline's renderer, children nested (stored collapse + local toggle), a
breadcrumb of parents; row click navigates to the block; reuse the embed renderer; children from
the client replica; fast on a page with hundreds of references; filters/sort/Link all keep working.

## Findings (before code)

- `page.backlinks` (server) returns `text` = the block's FIRST LINE only, no parent id. Full content,
  parents and children therefore come from the replica (as asked).
- Linked references are `path_ref` rows: every descendant of a referencing block is itself a
  linked reference (sql-schema.md rule 12). Rendering children nested without folding would show
  each child twice (nested, and as its own row). Real graph copy (2026-09-13), linked refs / rows
  whose parent is not itself a ref ("roots") / roots at top level:
  `@alex` 756/91/49, `task` 1074/584/53, `weekly review` 1092/86/83, `camp` 836/34/32,
  `call` 574/21/21, `journal` 912/66/34, `@robin` 242/47/33.
- Subtree sizes under those roots: descendants total = refs − roots (closure confirmed); largest
  single subtree 233 (`camp`), deepest 8 levels; 6–48 roots per page are stored collapsed; `task`
  roots have 693 ancestor rows (breadcrumbs), max ancestor depth 4.
- Logseq 0.10.9 `frontend/components/reference.cljs` (fetched 2026-09-13,
  https://raw.githubusercontent.com/logseq/logseq/0.10.9/src/main/frontend/components/reference.cljs):
  the header count is `total (count top-level-blocks)` where top-level blocks are those whose own
  `:block/refs` include the page, and children are shown nested under them.
- The query fence (`data/queries.ts`) already folds a hit under an ancestor hit — precedent.

## Plan / design (as built)

- `editor/render/ReadOnlyOutline.tsx`: the embed's outline + row, moved out of `EmbedView.tsx` so
  embeds and references share one read-only subtree renderer. Rows gained property chips
  (`BlockProperties`) and date chips (`DateChips`, click → the block, never the picker).
- `data/reference-trees.ts`: one replica read per list — `live ids` → ancestor chains
  (recursive CTE, ids as one `json_each` param) → subtrees of the outermost references (+ props)
  → ancestor text. `useReferenceListTrees` gates on the target so `.latest` from the previous
  page is never used. Exports `toBlockRow`/`BlockSqlRow` from core for the row mapping.
- `views/referenceNesting.ts` (pure): fold a reference under a listed ancestor (after the
  filter), hold back ids the read was not asked about yet, breadcrumb parents, and leave out a
  breadcrumb equal to the row above's.
- `views/ReferenceItem.tsx`: `ReferenceGroups` (moved out of the panel, keyed by page name and
  block id strings), `ReferenceItem`, `ReferenceBreadcrumb`; fallback to the server's first line
  when the replica lacks the block. `REFERENCE_ROW_CAP` 50 rows per reference.
- Panel: renders the list only once the read for this page landed ("Loading…" until then), so
  the list does not shrink under the reader.

Decisions:
- **Heading count stays blocks** (what `page.backlinks`/MCP report), not rows. Logseq counts
  top-level refs (see Findings). Rejected for now: needs the unfiltered heading to stop using the
  server's `linkedTotal`, and the filter popover's counts are per block too — two numbers that
  would disagree. Open question for the owner.
- **Filter + nesting**: a reference folds only under an ancestor that is in the *filtered* list; a
  shown block's outline is its real subtree, so an excluded child can still be seen inside it.
- Root honours stored `collapsed` (unlike a block embed, whose root is always open).

## Measurements (real-graph copy, `tools/probes/references-render-real-graph.mjs`)

Chromium headless, persistent profile (replica warm), M-series Mac shared with other agents.
`firstRow` = ms from navigation start to the first reference row; stalls = gaps >50 ms between
10 ms timer ticks (the Long Tasks API reported nothing in headless Chromium — a deliberate 120 ms
busy loop produced no entry — while the sampler showed it as one 127 ms stall). Baseline =
`51830cd`'s build; final = `6ce485b`'s build; same graph copy, run back to back.

| page (linked refs) | baseline: rows / firstRow | final: rows (outline rows, breadcrumbs) / firstRow | stalls load / refetch | row kept on refetch (baseline → final) |
|---|---|---|---|---|
| @alex (756) | 200 flat / 92 ms | 91 (456, 37) / 168 ms | 0 / 0 | no → yes |
| task (1074) | 200 flat / 96 ms | 200 (254, 66) / 202 ms | 0 / 0 | no → yes |
| camp (836) | 200 flat / 97 ms | 34 (309, 2) / 167 ms | 0 / 0 | no → yes |
| weekly review (1092) | 200 flat / 99 ms | 86 (284, 3) / 161 ms | 0 / 0 | no → yes |
| @robin (242) | 200 flat / 87 ms | 47 (179, 11) / 120 ms | 0 / 0 | no → yes |

An earlier run of an intermediate build (before identical breadcrumbs were left out) gave
103–141 ms; the spread between runs is load on the machine. The loader's SQL is ~3 ms in the
sqlite3 CLI for `task`'s 1,074 ids (1,923 chain rows), so the added ~70–100 ms is the worker round
trips plus rendering the rich rows. Refetch = a write elsewhere via the API while the page is open:
`page.backlinks` refetched (request counted); "row kept" = the first reference row is the same DOM
element afterwards — the old panel rebuilt every row on each refetch.

Screenshots (owner's content — scratch only, not committed): `refs-{baseline,after2}-*.png` in
the scratch dir. Checked by eye: nesting, breadcrumbs, DONE strike, stored folds, fences.

## Done

- `6ce485b` feat(web): a reference renders as the block in its page, children nested (B-550) —
  ReadOnlyOutline extraction, reference-trees loader, nesting, ReferenceItem/Groups/Breadcrumb,
  panel wiring, CSS; `views.spec` clicks the rendered row.
- Tests, all green at `6ce485b`: `pnpm --filter @nooklet/web test` 141 files / 1158 tests;
  `pnpm --filter @nooklet/core test` 21 / 408; `pnpm -r typecheck` clean; biome clean on every
  touched file. New: `ReferenceItem.test.tsx` 8, `referenceNesting.test.ts` 8,
  `reference-trees.test.ts` 4, `e2e/tests/references-render.spec.ts` 2 (both FAIL with the old
  `ReferencesPanel.tsx` swapped back in: 6 rows instead of 1, 4 instead of 3). Mutation check:
  dropping `.reverse()` in `referenceParents` fails 2 unit tests.
- e2e, port 6423, chromium: references-render + references + link-unlinked + embeds +
  references-filters + references-cap + views + tagged-pages 56/56 (before moving
  `ReferenceGroups` out of the panel); references-render + references + link-unlinked + embeds +
  references-filters + references-cap + views 54/54 at the committed code; pages + render-views +
  render-views-phone + tasks + namespace-paths + popups + navigation + journals + follow-link +
  context-menu + settings + parity + shelf 141 passed, 1 skipped (pre-existing: a conditional
  `test.skip` in settings.spec or the `test.fixme` in context-menu.spec).
- Docs: `docs/bugs-inbox/references-render.md` (B-550 fixed paragraph, B-551 logged); probes
  `tools/probes/references-render-real-graph.mjs`, `tools/probes/references-shape-real-graph.sql`.

## Adversarial verification (2026-09-13, separate agent)

On a fresh `.backup` copy of the graph (`scratchpad/m11e/verify-data`), server on 6424, real Chromium:

- Checked and holding: nested rendering and stored folds (`@Alex` ref `1m287mdbejacty` folded, toggle
  opens 19 rows, `collapsed` still 1, op count unchanged); a child row, a breadcrumb step and Enter
  on a row open the right block; sort, include/exclude filter (756/91 → 23/23 → 733/151 → back),
  "Show more" on `task` (one 52 ms stall for 200 more), unlinked mentions (`@Alex`: 465, first row
  106 ms after opening); no block rendered twice as a top-level row on any of 11 busy pages; no
  fallback rows; phone width (390 px) has no horizontal scroll; typing in bursts on `@Alex` and
  `weekly review` with the panel open: no stall over 50 ms, no input event over 16 ms; live
  API writes: a new child folds under its reference in ~90 ms, a new reference appears as a row,
  a deleted child disappears (one fallback-row flash of the new/deleted child was seen once and
  not reproduced in 25 further insert/delete cycles).
- Probe `tools/probes/references-render-real-graph.mjs` back to back: baseline (`51830cd` build)
  first row 71–99 ms; branch with the fix below 90–152 ms; no stalls either way; rows kept on refetch.
- **Defect found and fixed: B-552** — a breadcrumb step whose parent is a heading (`## 🔖 Articles`),
  a fence or empty rendered as an empty span (94 steps on 62 pages). `bf1811b`.
- Not changed, worth the owner's eye: the filter matches a block's own first-line refs (pre-existing),
  so excluding a page leaves the children of its blocks as rows whose breadcrumb names the excluded
  page; a breadcrumb step that is entirely a `[[page]]` link opens the page, and the parent block is
  then reachable only by keyboard (Enter on the step).
- Tests after the fix: `pnpm --filter @nooklet/web test` 141 files / 1160 tests; web typecheck clean;
  biome clean on changed files; e2e (port 6423, chromium) references-render, references,
  link-unlinked, embeds, references-filters, references-cap, views, render-views, tagged-pages 66/66;
  pages, render-views(-phone), navigation, journals, follow-link(-popup), popups, shelf(-outline),
  tasks, parity 116/116.

## In flight

- nothing.

## Not done (and why)

- Heading count in rows (Logseq's top-level count) — decision above; open question for the owner.
- Numbered-list ordinals in read-only rows — B-551, logged (a root's ordinal needs its page siblings).
- A ```` ```query ```` fence inside a reference renders as code (the renderer's depth rule, shared
  with embeds), not live results.
- Editing references in place — read-only by request.
- Within a page group, references still sort by last edit, not page order (unchanged).

## How to resume

Re-read this file and the branch's commits since `51830cd`. Everything is committed; what is left
is the open questions above.
