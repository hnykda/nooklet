# impl-embeds — embeds that transclude (audit §2 item 8)

Branch `m8/impl-embeds`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-26`,
started from `da85cfb`. e2e port 6407. Scratch (graph copy):
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-embeds/`.

Task: `{{embed [[Page]]}}` / `{{embed ((id))}}` render the target's blocks inline, read-only
(rows click through to the block; no nested editing), depth-limited, with a cycle guard.

## Findings (before code)

- Today: `editor/render/tokens.tsx#EmbedView` renders a box "Embed: [[X]]" — no data seam.
  `livePreview.ts` leaves `{{embed}}` as raw text while editing (fine: editing shows source).
- Real graph copy (2026-09-13): 6 blocks contain `{{embed`, all **block** embeds, all pointing at
  a block on an earlier journal day (a task list carried forward); subtrees of 6–60 blocks, up to
  depth 4. Two targets are `collapsed` at the root (`1m287mdbejad8x`, `1m287mdbkcaggj`), so an
  embed that honoured the root's collapse would show one line — the root is always expanded.
  One of the six is malformed (`{{embed ((1m287mdbf2xh43))}` — one closing brace) and tokenizes
  as text + a block ref, not an embed. No page embeds in the real graph.
- `QueryFenceView.tsx` is the precedent: lazy component behind a Suspense in `tokens.tsx`,
  imports its data module directly, mocked in component tests.
- Query-fence hits carry `data-block-id`, the same attribute `revealOnPage`/remote flash look up
  rows by → logged as B-211, not fixed here. Embedded rows use `data-embed-block-id` instead.

## Plan / design

1. `data/embeds.ts`: `loadEmbed(target, deps)` (page by key/journal-day fallback → `getPageTree`;
   block → its page → `getPageTree` → find node) + `useEmbed` resource stamped on
   page/block/block_prop. Fetcher never rejects (errored resources re-throw on read).
2. `editor/render/EmbedView.tsx` (lazy, own Suspense in tokens.tsx, placeholder as fallback):
   read-only outline, click row → `onNavigate({kind:"block"})`, root always expanded, deeper
   collapsed nodes collapsed with a view-local toggle, node cap, depth limit (`refDepth`, 2),
   cycle guard via `RenderCtx.embedPath` (block ids on the render path; an embed whose resolved
   tree contains one is a cycle).
3. `BlockRowView` passes `embedPath: [props.id]`.
4. Tests: `data/embeds.test.ts` (node:sqlite), `editor/render/embed.test.tsx` (component, mocked
   data), `e2e/tests/embeds.spec.ts`.

## Done

- Step 1 (this commit, "feat(web): embeds render…"): `data/embeds.ts` + `data/embeds.test.ts` (6),
  `editor/render/embedRows.ts` + test (5), `editor/render/EmbedView.tsx` + `embed.css` +
  `embed.test.tsx` (14), hookup in `tokens.tsx` (lazy `Embed` + `RenderCtx.embedPath`, exported
  `MAX_REF_DEPTH`) and one line in `BlockRowView.tsx`. Web unit suite 709/709 (one earlier full run
  had a single waitFor timeout, unidentified; the embed test's waits now allow 5 s for the lazy
  chunk). Mutation check: with the cycle guard disabled the three cycle tests fail and the depth
  limit still terminates.
- Inbox: B-210 (this feature, open until e2e is green), B-211 (query hits' `data-block-id`, open).
- Lint note: `biome check apps/web/src/editor/BlockRowView.tsx` reports
  `noStaticElementInteractions` on `.vr-row` — present at `da85cfb` too, not from this branch.

## In flight

- `e2e/tests/embeds.spec.ts` on port 6407.

## Next

1. e2e spec: block embed renders subtree; row click navigates (URL `?block=`); frame click edits
   host (raw `{{embed ((id))}}`); page self-embed shows the cycle notice and the page stays usable;
   nested depth limit; an edit to the target shows up in the embed without reload.
2. Real graph copy: serve it on a spare port, open the six embed days, screenshot/DOM-check.
3. Spec row in `docs/spec/markdown-grammar.md` §4 (read-only, not read-write), inbox B-210 → fixed.

## How to resume

Read this file, `git log --oneline da85cfb..m8/impl-embeds`, then continue at "In flight".
