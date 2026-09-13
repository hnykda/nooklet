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

## In flight

- Real-graph check (B-104 alias routes, B-111 `journal` page) + final verify.

## Next steps, in order

1. Serve the real-graph copy on 6406 (not during e2e), check `/page/daně` -> Taxes,
   `/page/zahrada` -> Garden, `/page/journal` lists 825 days (200 shown), `page.backlinks
   {target: "book"}` lists the tagged highlights page. Keep the probe in `tools/probes/`.
2. `pnpm nooklet verify` on the copy again (reads/serve do not write ops, but check).

## How to resume

`git log --oneline da85cfb..m8/impl-refs`, then this file, then `docs/bugs-inbox/impl-refs.md`.
Real-graph copy: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-refs/graph`
(re-create with `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"` if gone).
