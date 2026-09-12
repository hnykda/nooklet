# ADR 020: Block/page refactors and graph replace are server ops; a merge rewrites, aliases, and deletes

Date: 2026-09-12. Status: accepted.

## Context

Four of the most-asked-for things in Logseq's forum (research/13 §4.2, items 3 and 4) are
structural edits that touch many blocks at once: turn a block into a page, move a block to a page,
merge two pages, and find-and-replace across the graph. Each is easy to do badly. A merge that
leaves `[[Old]]` pointing at a deleted page, a "turn into page" whose children vanish, a replace
that changes 800 blocks and cannot be taken back. The questions this ADR settles:

1. Where does the logic live — in the client, which has the editor, or on the server, which has
   the `ref` index?
2. What exactly does `page.merge` do to references, aliases, properties and the source page?
3. What does "one batch" mean when a refactor creates a page, moves a subtree and rewrites text?

## Decision

### 1. All four are server ops, and the client calls them

`block.to_page`, `block.move_to_page`, `page.merge` and `graph.replace` are `defineOp` registry
entries (`packages/server/src/ops/`), exposed over HTTP and as MCP tools like every other write.
The web client's context-menu entries, the "Merge this page into…" palette command and the Find &
Replace view call them over `/api/v1/*` and then pull (`apps/web/src/app/refactor-host.tsx`),
rather than minting ops locally.

Two of the four cannot be done on the client at all: a merge and a graph-wide replace need every
reference to a page, and `ref`/`path_ref` are server-only derived tables (sql-schema.md rule 1).
The other two could be local, but then the same feature would exist twice — once as client op
building, once as an MCP tool — and drift. An agent turning a block into a page and a person
right-clicking "Turn into page" run the same code and get the same batch id. The cost is that these
four edits do not work offline; that is already true of search and backlinks and is the right
trade for a refactor that must see the whole graph.

### 2. Merge semantics: move, rewrite, alias, fill, delete — in that order, in one batch

`page.merge(source, target)`:

- **Move.** Every top-level block of `source` is placed at the end of `target`'s top level, in
  order, with its subtree. Ids do not change, so `((block refs))` keep working.
- **Rewrite.** Every `[[link]]`, `[[link|label]]`, `#tag` and `#[[tag]]` whose reference key is
  `source`'s own key *or any of its alias keys* — in any casing, in any journal-date spelling — is
  rewritten to `target`'s name: in block text (outside code spans and fences, the same exclusions
  the `ref` index applies), in block `tags::`/`alias::` lists, in other block properties, and in
  the `tags::` of pages that tag `source`. A label after a pipe is kept. A bare `#old` becomes
  `#[[Two Words]]` when the new name cannot be written bare.
- **Alias.** `source`'s name and its own aliases are appended to `target`'s `alias::`
  (`keep_alias: false` drops the name, never the aliases). This is the safety net for what the
  rewrite cannot reach: unlinked mentions, Markdown files outside the graph, a `[[Page|label]]`
  link that `refs.ts` does not index yet (B-86). It also means the old URL and the old name in the
  page switcher keep resolving.
- **Fill.** `target`'s `tags::` becomes the union; any other property `source` had and `target`
  lacks is copied. `target`'s own values always win — the person chose which page survives.
- **Delete.** `source` is soft-deleted. Its blocks are already `target`'s, so no block tombstones
  are written.

All of it goes through one `ctx.applyOps` call: one `batch_id`, one `batch_undo`. A journal day
cannot be a `source` (it is addressed by date; `block.move_to_page` moves its blocks), and a page
cannot be merged into itself, including through an alias.

### 3. "One batch" means one `applyOps`, with page creation minted inline

`block.to_page` and `block.move_to_page` may need a page that does not exist. They do not call
`DataApi.pages.create` — that runs its own `serverApplyOps` with its own batch id, and a page made
that way survives the undo of the move that needed it (B-57's shape again). Instead
`resolveOrMintPage` returns the `page.create` op to include in the caller's batch.

The same principle fixes B-85. `@nooklet/core`'s `applyBlockPlace` updates exactly the row the op
names, so moving a parent to another page left its children with the old `page_id` and they
vanished from both pages. The reducer stays one-op-one-row; `subtreePlaceOps` (`data-api.ts`)
emits a `block.place` for every descendant, parent-first, changing only the page. Each moved block
therefore has its own `changes` row and is restored individually by `batch_undo`.

## Why not the alternatives

**Merge by alias only, no rewrite.** Add `alias:: Old` to the target, delete the old page, done.
Every link keeps working through alias resolution. Rejected: the text still says `[[Old]]` forever,
so the graph's own files (the Markdown mirror, grep, an export) disagree with what the app shows;
and the alias becomes load-bearing — remove it later while tidying properties and hundreds of links
silently break. The rewrite makes the graph honest; the alias catches the remainder.

**Rewrite to `[[Target|Old]]` to preserve the reading text.** Keeps prose intact. Rejected: the
link then says one thing and means another in every place it appears, which is exactly the kind
of hidden indirection this project avoids (ADR 018 rejected rewriting journal titles for the
mirror-image reason: do not edit prose to expose a storage decision — here the *link* is the
storage decision). A label the person wrote is kept; one the merge invented would not be theirs.

**Keep the source as an empty redirect page.** Logseq-style. Rejected: a page with no blocks that
exists only to redirect is clutter in every page list, and the alias already redirects.

**Hard-delete the source.** Rejected on ADR 003 grounds — tombstones are what sync and undo are
built on.

**Cascade `page_id` inside the core reducer** instead of emitting per-descendant ops. Would fix
B-85 for `block.move` too with no op-layer change. Rejected for now: it makes `block.place` mean
two different things depending on whether the page changed, every client's reducer must agree on
the cascade, and the `changes` audit would show one moved block where a hundred moved. The
per-descendant ops are more log but they are the truth. `block.move`'s `page:` form should adopt
`subtreePlaceOps` (B-85's open half).

**A client-side replace over the local replica.** Would work offline. Rejected: the client's
change bus and undo history are per-block and per-edit; the server's `batch_id` is the only
existing "undo 800 blocks at once" primitive, and the preview must be computed by the same code
that writes.

## Consequences

- `docs/spec/mcp-tools.md` gains §4.3.25–28 and rows 26–29 in the catalog. Op-name segments may
  now contain `_` for multi-word verbs; `OpRegistry.register` refuses a tool-name collision.
- `page.update`'s rename inherits the alias/case-aware rewrite (`buildRefRewriteOps`) — `#Old`,
  `#[[Old]]`, `[[old]]`, block `tags::` and page-level `tags::` are rewritten on rename too, which
  the v1 substring replace did not do.
- `DataApi.blocks.move` moves subtrees correctly across pages. `ops/block-move.ts` does not yet
  (B-85).
- The Find & Replace view is `/replace`; it has no sidebar entry yet (`shell/**` is another agent's
  this session) and is reached by URL or the "Find and replace…" palette command.
- Still unverified: merging two pages that both carry `icon`/`favorite`-style properties from the
  UI agents' work (the fill rule copies them only when the target lacks them; whether that is the
  right call for `icon` is a taste question nobody has hit yet).
