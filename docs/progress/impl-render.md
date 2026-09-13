# impl-render (m8) — progress

Branch `m8/impl-render`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-9`, started from `da85cfb`
(the worktree was created at an older commit, `41666ee`; the fresh branch was reset to `da85cfb`
before any work). Task: B-100 numbered lists render, B-101 block properties visible + `/property`
writes a real property, B-99 `/image` opens a picker and uploads. e2e port 6401.

## Done
- `6fb7ae6` core `block-text.ts` (split/join/offset maps/diff for a block's editing text) + tests;
  B-151 logged with probe `tools/probes/serialize-fence-props.ts`.
- `4d3750f` B-100: worker tree carries `properties`; `EditableBlock.properties` replaces
  `listNumber`; e2e numbered-list tests.
- `89c0f22` B-101: editing text in the buffer (flush → `block.text` + `block.prop`), chips
  (`editor/BlockProperties.tsx`), `/property` (`:: ` under line 1), undo/optimistic/history for
  generic props, Enter continues numbering, duplicate copies props, spec OUT-22a.
- `d7137b1` B-99 `/image` (hidden file input → `uploadImageAsset` → caret) and B-150 (upload had
  no token; now `callOp`).
- (this commit) "Numbered list" command + slash item (`commands/registrations/numbered-list.ts`),
  real-graph probe `tools/probes/real-graph-properties.mjs`, keymap spec rows, inbox write-ups.

## Verification (all on this branch)
- e2e on 6401: `block-properties.spec.ts` 8/8, `image-insert.spec.ts` 2/2 (both red before the
  fix), `popups.spec.ts` 43/43 (with the new slash item), `assets.spec.ts` 1/1; regression run of
  editing/popups/focus/selection/parity/tasks/templates/rendering/render/assets/shelf/context-menu
  156 passed, 1 skipped (before the numbered-list command and `/image`; popups rerun after).
- Unit: core 357/357; web 699 in total — two full runs each had ONE different failure
  (`render-seams.test.tsx`, then `page-title.test.ts`), both pass alone; unrelated to this work
  and consistent with machine load.
- Real graph copy: probe 9 pages, 177 numbered rows + 70 chip rows, 0 wrong; a UI property write
  → one op; `nooklet verify` OK (20,412 ops).
- `pnpm -r typecheck` clean. Biome: one pre-existing error in `BlockRowView.tsx` (row div
  `noStaticElementInteractions`, present at `da85cfb`).

## Not done / follow-ups
- Enter on an empty numbered item does not end the list (Logseq does).
- Image drag-and-drop onto a block.
- B-151 (core serializer, fence-first block + properties, `ids: "none"`) — logged, not fixed.
- Typed reserved-key lines (`scheduled:: …`) stay content text in the buffer (by design, OUT-22a);
  dates belong to B-96/B-102.
- Chips are under the whole content, not between line 1 and line 2 (Logseq's placement) — see
  decision 4.

## Design decisions
1. **Data seam.** Generic `block_prop` rows (non-null values) are projected into
   `BlockTreeNode.properties` by the worker's page-tree query (`db/worker-core.ts`), and from there
   into `EditableBlock.properties`. Core's `BlockRow` is untouched (server code shares it).
2. **Editor buffer = editing text** (content + generic property lines, key order; Logseq's raw
   edit mode and the shape `block.update` raw text uses). Flush splits it back with the outline
   parser's own rules into `block.text` + `block.prop` ops diffed against the block as the edit
   began — never against live props, so a property an agent set meanwhile is not clobbered.
   `CaretSpec` offsets inside `BlockTree.tsx` are content offsets; the surface boundary converts.
3. **Reserved keys stay out of the buffer** (`id collapsed marker priority scheduled deadline
   repeat done`, plus `heading`): a typed `scheduled:: …` line stays content text as before.
4. **Chips go below the whole rendered content**: the rendered view's click-to-caret offsets
   (`caret.ts`, `data-from`) assume one `BlockContentView` over the whole content. Only 33 of ~400
   non-`list` property blocks in the owner's graph are multi-line.
5. **`/property` inserts `:: `, caret before it** — a `key` placeholder is itself a valid property
   line and would be written as junk at the first typing pause; selecting it for overtyping needs a
   selection the editor host's `setText` collapses.
6. **Hidden chip keys** follow Logseq's `hidden-built-in-properties` (fetched 2026-09-13 from
   `deps/graph-parser/src/logseq/graph_parser/property.cljs`) plus `list`.

## How to resume
`git log --oneline da85cfb..m8/impl-render`, then this file and `docs/bugs-inbox/impl-render.md`.
Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-render/`
(real-graph copy in `graph/` — it has one probe write in it now; take a fresh `.backup` for a clean
run).
