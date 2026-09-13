# impl-refs — progress

Branch `m8/impl-refs`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-25`, e2e
port 6406, new bug numbers B-200..B-209. Bugs go to `docs/bugs-inbox/impl-refs.md`, never
`docs/BUGS.md`.

## Brief

1. **B-89** — reserved keys (`marker`/`priority`/`collapsed`) in a `block.create` `properties` bag
   are dropped. Fix at the op layer (`packages/core/src/sync/apply-ops.ts#applyBlockCreate`), test
   in `packages/core/src/sync/apply-ops.test.ts`.
2. **B-104** — `/page/<alias>` 404s in the UI. Resolve aliases in `usePageByName` (client replica:
   `page_prop` alias rows, parsed with the server's rule, shared through core) and redirect the
   route to the canonical name.
3. **B-111** — ADR 017's `tagged_pages`: `page.backlinks` returns pages carrying the tag (from
   `page_tag`), MCP description says so, References panel shows "Pages tagged X" above linked
   references.

## Note on the starting commit

The worktree was created at `41666ee` (an old commit), not `da85cfb`. The branch was created there
and immediately `git reset --hard da85cfb` before any work (no commits lost; nothing else touched).

## Done

- B-89 fixed in core (`applyBlockCreate` folds the three bag keys into the INSERT); core tests +
  `packages/server/src/block-create-bag.test.ts`; sql-schema.md rule 24 updated. Core 335/335,
  server 522/522, typecheck clean, verify OK on the real-graph copy (20,411 ops).

- B-89 commit `03d8422`.
- B-104 fixed: core `page-alias.ts` (parser moved from server), client `data/page-alias.ts` +
  `usePageByName` fallback (stamped on `page_prop`), `views/canonicalPageRoute.ts` redirect hooked
  into `PageView` (2 lines). e2e `page-identity.spec.ts` 5/5; all 5 fail on da85cfb's client; the
  "no bounce" test fails with the loading guard removed. Neighbour specs (pages, navigation,
  journals, references, refactor, shelf, history, page-icons + identity): 53 passed. Web unit
  692/692.

- B-104 commit `713f059`.
- B-111 fixed: `page-tags.ts#pagesTaggedWith`, `page.backlinks` `tagged_pages`/`tagged_total` +
  description + render; spec §4.3.6, ADR 017 note, 3 wiki pages; client `api-client.ts` types,
  `views/TaggedPages.tsx` + `tagged-pages.css`, hookup in `ReferencesPanel.tsx`. Server 528/528,
  web 695/695 (one earlier full run had 1 failure in `page-title.test.ts`, passed alone and on the
  full rerun — load), e2e tagged-pages 3/3 (all fail on da85cfb), neighbours 53 passed. Logged
  B-200 (uncreated page shows no references) — open, not fixed.

- B-111 commit `a4ba8fd`.
- Real-graph probe `tools/probes/refs-real-graph.mjs` on a copy served at 6406: alias routes
  (daně → Taxes, zahrada → Garden, bracketed alias with commas) redirect in ~250 ms; `journal` page
  shows "Pages tagged journal" 825 (200 shown, note present) above linked refs; API journal 825 in
  8–14 ms; `book` tagged page listed. Verify on the copy afterwards: OK, 20,411 ops.

- B-201 (found reviewing B-104: a half-typed page title reverted whenever any other page changed;
  predates the branch, B-104's `page_prop` stamp widened it) fixed in `store.ts#usePageByName` by
  reusing the previous row object when unchanged; e2e `page-title-draft.spec.ts` (fails with the
  reuse disabled). Broad e2e set (13 specs) 90 passed / 1 failed (`references.spec.ts` "no
  references means no panel at all", 12 s timeout) — passed alone and in the same file order (83
  passed): load.

- Probe commit `df36a2e`; B-201 commit `0ccd0a0`. Final unit: core 338/338, server 528/528, web
  695/695; `pnpm -r typecheck` clean.

## In flight

Nothing. B-89, B-104, B-111, B-201 fixed and committed; B-200 logged open.

## Merge notes for the coordinator

- `m8/rv-web-security` moves `pageRoutePath`/`pageZoomRoutePath` to `routes/page-path.ts` and
  rewrites `api-client.ts#pageBacklinks` around `callOp`. After merging both: point
  `views/canonicalPageRoute.ts`'s import at `../routes/page-path.js`, and re-add the two
  `taggedPages`/`taggedTotal` lines to the rewritten `pageBacklinks` mapping (plus the wire type).
- `m8/qafix-render-sync` edits `PageView.tsx` near the title effect; this branch adds only an import
  and one `useCanonicalPageRoute(...)` line there.

## Next steps, in order

1. (Coordinator) fold `docs/bugs-inbox/impl-refs.md` into BUGS.md: B-89, B-104, B-111 fixed; B-200
   open (an uncreated page shows no references — touches `PageView.tsx`, a product call).
2. Not built from ADR 017: a remove control for `property` tags vs none for `intrinsic`.

## Decisions

- B-89: a set top-level `marker`/`priority`/`collapsed` wins over the bag; `null`/`false` counts as
  unset (core producers always send those defaults next to a bag).
- B-104: parser shared through core (`page-alias.ts`), not duplicated in the client; redirect only
  for non-journal pages; waits for the resource to finish loading (else links bounce back).
- B-111: `tagged_pages` windowed by the same `limit`/`cursor` as `linked`, plus `tagged_total`;
  target's alias keys count; the target never lists itself; named pages before journal days.

## How to resume

`git log --oneline da85cfb..m8/impl-refs`, then this file, then `docs/bugs-inbox/impl-refs.md`.
Real-graph copy: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-refs/graph`
(re-create with `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"` if gone).
