# M7 — block/page refactors and find & replace: progress

Owner brief: research/13 §4.2 items 3 and 4. Server ops `block.to_page`, `block.move_to_page`,
`page.merge`, `graph.replace`; client context-menu entries, palette command, `/replace` view;
e2e; real-graph verification of a merge. This file is the resumable state — if it exists when
you start, you were restarted: read it, then continue from "Next steps".

## 1. Done

- Server helpers in `packages/server/src/data-api.ts`: `subtreePlaceOps`/`subtreeBlockIds`
  (B-85 fix at the op layer), `buildRefRewriteOps` + `rewriteRefsInText` (alias/case-aware
  reference rewrite; `buildWikilinkRewriteOps` is now a wrapper so `page.update` inherits it),
  `DataApi.blocks.move` moves subtrees. — uncommitted
- `docs/BUGS.md`: B-85 (cross-page move strands children), B-86 (`[[Page|label]]` indexed
  under `page|label`). — uncommitted
- `packages/server/src/ops/registry.ts`: op-name segments may contain `_`; registration refuses
  an MCP tool-name collision. — uncommitted
- Four ops + tests, all green (`pnpm --filter @nooklet/server test`: 506/506 after the last
  expectation fix): `ops/block-to-page.ts`, `ops/block-move-to-page.ts` (exports
  `resolveOrMintPage`), `ops/page-merge.ts`, `ops/graph-replace.ts`, each with `*.test.ts`.
  Registered in `ops/index.ts`; names in `mcp/server.test.ts`. — uncommitted
- `docs/adr/020-refactor-ops-merge-semantics.md`; `docs/spec/mcp-tools.md` rule 3.1.1 text,
  catalog rows 26–29, §4.3.25–28. — uncommitted
- Client, host-agnostic half: `apps/web/src/data/refactor-api.ts`,
  `apps/web/src/commands/registrations/refactor.ts` (+ `refactor.test.ts`, not yet run). —
  uncommitted

## 2. In flight

- Nothing mid-edit right now. All files above are complete on disk.

## 3. Next steps, in order

1. Commit server work in three commits (see §5 for the partial-stage recipe for shared files):
   (a) data-api + BUGS + this file; (b) registry + 4 ops + tests + index/mcp-test hunks;
   (c) ADR 020 + spec.
2. Client real half: `apps/web/src/app/refactor-host.tsx` (RefactorHost impl: API calls,
   `forceSync()` after each write, page picker rendered on demand with `render()` from
   `solid-js/web`, reusing `.cmd-overlay/.cmd-palette/.cmd-input/.cmd-row` classes and
   `views/pageSearch.ts#fuzzyFindPages`, `claimPopupKeys` for Escape).
3. Wire: `commands/registrations/index.ts` (append `createRefactorCommands` when
   `deps.refactor` given; export), `app/CommandLayer.tsx` (one dep line), `app/BlockContextMenu.tsx`
   ENTRIES (append "Turn into page", "Move to page…" after a separator).
4. `apps/web/src/views/FindReplaceView.tsx` + `find-replace.css`; `App.tsx` route `/replace`
   (+ import line). Run `pnpm --filter @nooklet/web test`, typecheck, biome.
5. e2e: `e2e/tests/refactor.spec.ts`, `e2e/tests/replace.spec.ts`;
   `cd e2e && NOOKLET_E2E_PORT=6352 pnpm exec playwright test tests/refactor.spec.ts tests/replace.spec.ts`.
6. Real-graph check: copy, merge two pages over HTTP against a `serve` on the copy, then
   `pnpm nooklet verify --data <scratch>`.
7. Full e2e on 6352 once; `pnpm -r typecheck`; `pnpm -r test`; biome on my files. Final report.

## 4. Decisions (why)

- **Server ops, client calls them** (ADR 020 §1): merge/replace need the `ref` index; one code
  path for the menu item and the MCP tool.
- **Merge = move, rewrite, alias, fill, delete, one batch** (ADR 020 §2). Rewrite makes the
  graph honest; alias is the safety net; target's values win; source soft-deleted.
- **One batch means one `applyOps`**: page creation is minted inline (`resolveOrMintPage`),
  never via `DataApi.pages.create` (own batch id → undo would leave the page).
- **B-85 fixed at the op layer** with per-descendant `block.place` ops, parent-first (reducer
  nulls a parent not on the same page). Core reducer left one-op-one-row.
- **Replace preview is the op** (`dry_run`), matching in JS (SQLite `lower()` is ASCII-only;
  graph is half Czech). Real run is one `applyOps` → one `batch_id`. `max_blocks` guard
  (default 2000) against a loose pattern; empty-matching regex refused.
- **Op names with `_`** (`block.to_page`): registry grammar widened; tool-name collision now
  checked at registration instead (mcp-tools.md rule 3.1.1 updated).

## 5. How to resume

- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`
- Graph copy for verification (make it if missing):
  `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph-copy/graph.sqlite'"` then
  `pnpm nooklet serve --data <scratch>/graph-copy --port 6353`, merge over HTTP with the token
  from `GET /api/session`, then `pnpm nooklet verify --data <scratch>/graph-copy`. Never point a
  `nooklet` command at `~/.nooklet/default`.
- e2e port: **6352**, always. `cd e2e && NOOKLET_E2E_PORT=6352 pnpm exec playwright test …`.
- Unit: `pnpm --filter @nooklet/server test`, `pnpm --filter @nooklet/web test`.
- Shared files other agents also edit (re-read before every edit): `ops/index.ts`,
  `mcp/server.test.ts`, `BlockContextMenu.tsx` (ENTRIES), `registrations/index.ts`, `App.tsx`,
  `docs/BUGS.md`, `docs/spec/mcp-tools.md`. Their op files (`page-history`, `trash-*`) were
  untracked when I looked, so `ops/index.ts` and `mcp/server.test.ts` must be committed with
  ONLY my hunks: build the blob from `git show HEAD:<path>` + my lines, `git hash-object -w`,
  `git update-index --cacheinfo 100644,<sha>,<path>`, commit; the working tree keeps everyone's.
- Commit trailer (exactly):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` /
  `Claude-Session: https://claude.ai/code/session_014zmrHaeuokMBDD83XdybrJ`. Never push, never
  `git add -A`.
