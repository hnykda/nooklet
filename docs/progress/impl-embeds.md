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

- `63cb3d9` feat(web): `{{embed}}` renders the embedded page/block read-only (B-210) —
  `data/embeds.ts` + `data/embeds.test.ts` (6), `editor/render/embedRows.ts` + test (5),
  `editor/render/EmbedView.tsx` + `embed.css` + `embed.test.tsx` (14), hookup in `tokens.tsx` (lazy
  `Embed` + `RenderCtx.embedPath`, exported `MAX_REF_DEPTH`) and one line in `BlockRowView.tsx`.
  Mutation check: with the cycle guard disabled the three cycle tests fail and the depth limit still
  terminates.
- `7e79721` test(e2e) + fix(web) B-212: `e2e/tests/embeds.spec.ts` (9 tests, green on 6407); B-212 fix in
  `editor/editor.css` + `shell/shelf.css` (done-strike selectors scoped to the block's own marker),
  each of its three halves seen failing first; `tools/probes/embeds-real-graph.mjs` run on a copy of
  the owner's graph: 5 well-formed embeds render (31/6/12/27/27 rows), the malformed one tokenizes as
  text+blockRef+text, no page errors; spec rows in `docs/spec/markdown-grammar.md` §4/§5 say
  read-only; inbox B-210 and B-212 fixed, B-211 open.
- Neighbouring e2e run after step 1: render, rendering, query, shelf, shelf-outline, editing,
  references, popups — 73/73. After step 2: embeds + tasks + shelf — 26/26.
- Lint note: `biome check apps/web/src/editor/BlockRowView.tsx` reports
  `noStaticElementInteractions` on `.vr-row` — present at `da85cfb` too, not from this branch.

- `354449c` fix(web): `shell/Shelf.tsx` passes `embedPath: [node.id]` too; e2e "on the shelf, a
  self-embedding block shows the notice rather than a copy of its page" failed first (2 rows), then
  embeds + shelf + shelf-outline 16/16.
- Broader e2e after `354449c`: journals, selection, context-menu, navigation, focus, phone, tasks,
  views — 118 passed, 1 failed: views.spec "opening the palette while editing and closing it hands
  focus back to the editor", failing 3/3 including with this branch's modified web files checked
  out at `da85cfb` → pre-existing, logged as B-213 (not fixed). Final embeds.spec: 10/10.

## In flight

- nothing.

## Not done (and why)

- Editable transclusion (editing embedded blocks in place): a nested `BlockTree` with its own
  surface, a day+ per the audit; read-only is what was asked first.
- Alias resolution for `{{embed [[alias]]}}`: `data/embeds.ts#findPageId` mirrors
  `store.ts#usePageByName` (key, then journal day); when aliases land there (audit §2 item 5), the
  same fallback belongs here.
- B-211 (query hits' `data-block-id`) is logged, not fixed — QueryFenceView is not this task.
- Live preview while editing still shows the raw `{{embed …}}` (spec §5 row updated to say so).

## How to resume

Read this file, `git log --oneline da85cfb..m8/impl-embeds`, then continue at "In flight".

## Adversarial verification (2026-09-13, second agent)

Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-embeds-verify/`
(graph copy in `graph/`, probes `probe-*.mjs` — run them from `e2e/` against a server on 6407).

- Re-ran at `18b053d`: embed unit tests 25/25, `embeds.spec.ts` 10/10.
- `65a1b8f` + `6812e1e`: **B-214 found and fixed** — typing anywhere on a page rebuilt its embeds
  (placeholder flash, page jumps, unfolded rows fold). Fix in `BlockRowView.tsx` (string memo); e2e
  test added, seen failing first. Web unit 709/709, web typecheck 0.
- In flight: broader e2e on 6407 over the row change (render, rendering, editing, references,
  tasks, query, shelf, selection, undo), then more probes (Czech/journal page embeds, large page
  embed typing latency, undo of the host, keyboard on embedded rows).
