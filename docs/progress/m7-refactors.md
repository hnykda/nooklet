# M7 — block/page refactors and find & replace: progress

Owner brief: research/13 §4.2 items 3 and 4. Server ops `block.to_page`, `block.move_to_page`,
`page.merge`, `graph.replace`; client context-menu entries, palette command, `/replace` view;
e2e; real-graph verification of a merge. This file is the resumable state — if it exists when
you start, you were restarted: read it, then continue from "Next steps".

## 1. Done

- `7b1aad0` fix(server): `subtreePlaceOps`/`subtreeBlockIds` (B-85 fix at the op layer),
  `buildRefRewriteOps` + `rewriteRefsInText` (alias/case-aware rewrite; `buildWikilinkRewriteOps`
  is a wrapper so `page.update` inherits it), `DataApi.blocks.move` moves subtrees; B-85/B-86
  logged in `docs/BUGS.md`; this file.
- `d06661b` feat(ops): the four ops + tests (`ops/block-to-page.ts`, `ops/block-move-to-page.ts`
  with `resolveOrMintPage`, `ops/page-merge.ts`, `ops/graph-replace.ts`), registry grammar
  widened (`_` in a segment) with a tool-name collision check, registered in `ops/index.ts`,
  names in `mcp/server.test.ts`. Server suite green for my files.
- `b1d3679` docs: ADR 020; `docs/spec/mcp-tools.md` rule 3.1.1, catalog rows 26–29, §4.3.25–28.
- On disk, uncommitted, typecheck/biome/unit green: `apps/web/src/data/refactor-api.ts`,
  `commands/registrations/refactor.ts` (+ `.test.ts`, 6 pass), `app/refactor-host.tsx` (host +
  page picker, `closePalette` hook), wiring in `commands/registrations/index.ts`,
  `app/CommandLayer.tsx`, `app/BlockContextMenu.tsx` (ENTRIES), `views/FindReplaceView.tsx` +
  `find-replace.css`, `App.tsx` route `/replace`; e2e specs `e2e/tests/refactor.spec.ts`,
  `e2e/tests/replace.spec.ts` (written, not yet run).

## 2. In flight

- Nothing mid-edit. Next action is committing the client files (C4/C5) and running the e2e.

## 3. Next steps, in order

1. Commit C4 (client commands/host/wiring) and C5 (view + route). Shared client files
   (`registrations/index.ts`, `CommandLayer.tsx`, `BlockContextMenu.tsx`, `App.tsx`) — check
   `git diff HEAD` first; other agents' routes (`/trash`, `/history`) were already in HEAD.
2. `cd e2e && NOOKLET_E2E_PORT=6352 pnpm exec playwright test tests/refactor.spec.ts tests/replace.spec.ts`;
   fix what fails; commit C6 (e2e).
3. Real-graph check: copy, merge two pages over HTTP against a `serve` on the copy, then
   `pnpm nooklet verify --data <scratch>`; record the result here.
4. Full e2e on 6352 once; `pnpm -r typecheck`; `pnpm -r test`; biome on my files. Final report.

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
