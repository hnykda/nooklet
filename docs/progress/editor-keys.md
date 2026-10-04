# editor-keys (M10) — progress

Branch `m10/editor-keys` from `007052a`, worktree `.claude/worktrees/wf_ced35de1-fb8-2`.
Scratch: `scratchpad/m10/editor-keys/`. e2e port 6400.

Task: B-282 (Cmd+Enter twice cycles once), B-294 (Enter on autocomplete inside an existing link
duplicates its tail), B-295 (keys after Alt+Enter follow-link land in the block being left), B-346
(marker commands on a multi-selection: act on all selected blocks as one undo step — coordinator's
instruction), B-344 (`/mermaid` after existing text puts the fence inline). Failing Playwright test
first for each. Bug notes go to `docs/bugs-inbox/editor-keys.md`, not BUGS.md.

## Done

- B-282 + B-346 (one commit, both in `commands/registrations/task.ts`): task commands queued
  (`createSerialRun`); marker commands write every selected block through new
  `Store.setPropsOfBlocks` as one batch; `clearMarker` when `isTask || blockSelected`;
  `external-batch.ts` refuses a batch touching a block the tree does not show. e2e
  `task-marker-keys.spec.ts` (2 tests) red before, green after (4/4 repeats); related specs
  (tasks, dates, undo-gaps, undo-redo, selection, commands, redo, template-undo, context-menu,
  palette-text-keys) 85 passed, 1 skipped. Web unit 1,136 green. Commit `da224b0`.
- B-294: a pick replaces through the `]]`/`))` of the link the caret is inside
  (`trigger.ts#existingRefTailLength`, `AutocompletePopup.tsx#queryEnd`). e2e
  `autocomplete-inside-link.spec.ts` (3; 2 red before). Tag form left open as new B-380 (owner
  decision; probe `tools/probes/autocomplete-tag-walk.spec.ts`). Autocomplete/follow-link specs green.
  Commit `fd0c38b`.
- B-295: `createNavigationHost` ends editing (`requestEditingEnd`) at the start of followLink
  (page/tag/block), openPage, openPageByRef. e2e `follow-link-typing.spec.ts` (2) red 5/5 before,
  green 5/5 after; navigation/focus specs 74 passed. Commit `7e15266`.
- B-344: client plugin host implements `editor.currentBlock/insertBlockAfter/focusBlock`
  (new `EditorHost.currentBlock`, `editor/current-block.ts`, `data/plugin-writes.ts`); `/mermaid`
  on a non-blank block inserts the starter as the next sibling. e2e `mermaid-after-text.spec.ts` (2)
  red before, green after; plugins.spec green. Web unit 1,152.

- Full chromium e2e on `246d61e`: 531 passed, 2 failed, 2 skipped (10.0 min). Both failures were
  `link-unlinked.spec.ts` counting 4 unlinked mentions of "Link Target" instead of 2 — my
  `autocomplete-inside-link.spec.ts` page names contained "Walk Link Target". Renamed to
  "Walkin Goal Page"/"Caret Inside Src …"; the two specs together (plus references, views,
  autocomplete, follow-link-popup) green on rerun. `references.spec.ts:77` timed out once in that
  rerun and passed alone (load).

- Final e2e on `8c390b7`, in two halves (the whole suite is ~10 min, the tool's foreground limit):
  `tests/[a-l]` 181 passed, 1 skipped (4.5 min); `tests/[m-z]` 350 passed, 2 failed, 1 skipped
  (7.3 min). The 2 were `page-icons.spec.ts` (grapheme/clear read without a poll; agent icon got a
  401 from the page's window token) — both passed 3/3 alone straight after; logged as B-381.

## In flight

- Nothing. Branch done; see "Left for the owner".

## Left for the owner

- B-380: `#tag` form of B-294 (options in the inbox entry).
- B-295 covers followLink/openPage/openPageByRef; back/forward/openJournals/openSearch unmeasured.
- B-344: `/mermaid` into a block whose create has not reached the replica rejects (by reading).
- B-381: page-icons spec flake (not this branch's code).

## Decisions

- B-282: serialize rather than read from the editor tree. Verified ordering: tree `commit` posts
  `applyLocalOps` synchronously; worker `applyLocalOps` is sync (`worker-core.ts`), so the queued
  command's replica query sees the write.
- B-346: brief said "like Set scheduled date now does (B-345)" but B-345 gated instead; followed the
  explicit instruction (act on all). `task.cycle` stays single-block.

## How to resume

`git log m10/editor-keys` for landed commits; the inbox file names each test.
Run e2e: `NOOKLET_DATA=<scratch>/data NOOKLET_E2E_PORT=6400 pnpm --dir <worktree>/e2e exec playwright test tests/<spec> --project=chromium`.
