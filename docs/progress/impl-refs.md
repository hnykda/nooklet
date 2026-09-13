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

## In flight

- B-104.

## Next steps, in order

1. B-104: `aliasKeysOf` into core; client alias fallback + redirect; unit + e2e; commit.
2. B-111: server output + MCP description + spec; panel section; unit + e2e; commit.
3. `pnpm nooklet verify` on the real-graph copy; real-graph check of Journal tag page and an alias.

## How to resume

`git log --oneline da85cfb..m8/impl-refs`, then this file, then `docs/bugs-inbox/impl-refs.md`.
Real-graph copy: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-refs/graph`
(re-create with `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"` if gone).
