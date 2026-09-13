# impl-editor progress (m8)

Branch `m8/impl-editor`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-12`, based on `da85cfb`.
e2e port 6405. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-editor/`.

Task: B-108 (template insert not undoable) and B-88 (editing row outlives its block). Failing
Playwright test first, then the fix, then remove the refactor-command workaround for B-88.

## Done

- (nothing but this file and the inbox entries yet)

## In flight

- Inbox entries logged (`docs/bugs-inbox/impl-editor.md`).

## Next, in order

1. Failing e2e for B-108: `e2e/tests/editor-undo-batches.spec.ts` — insert a template (both
   shapes), Cmd/Ctrl+Z, the blocks are gone.
2. Fix B-108: `data/templates.ts` returns unapplied ops; a new `EditorHost.commitOps` lets a
   command commit a batch through `BlockTree`'s `commit` (one history step); plain `applyOps`
   when no mounted tree owns the block.
3. Failing e2e for B-88: `e2e/tests/editor-row-lifecycle.spec.ts` — caret in a block, move or
   delete it through the API, the row must go.
4. Fix B-88 in `BlockTree.tsx`'s tree effect: keep an absent editing row only while it is a local
   creation no refetch has seen yet; otherwise end editing. Remove `leaveEditing` from
   `commands/registrations/refactor.ts`.

## Decisions

## How to resume

`git log --oneline da85cfb..m8/impl-editor`, then this file's Next list.
