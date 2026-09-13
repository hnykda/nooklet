# impl-editor progress (m8)

Branch `m8/impl-editor`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-12`, based on `da85cfb`
(the worktree was created at an older commit, 41666ee; the fresh branch was reset to `da85cfb`
before any work). e2e port 6405. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-editor/`.

Task: B-108 (template insert not undoable) and B-88 (editing row outlives its block). Failing
Playwright test first, then the fix, then remove the refactor-command workaround for B-88.

## Done

- Plan + inbox entries logged (first commit on the branch).
- **B-190** (found writing B-108's redo assertion; pre-existing): redo of an undone create never
  reached the database. `editor/history.ts#redoRecipes` revives each redone create. Test
  `e2e/tests/redo.spec.ts` (failed before, passes after). Commit `c510633`.
- **B-108**: `/template` is one editor undo step. `EditorHost.commitOps` seam
  (`commands/hosts/editor-host.ts`, `app/editor-host.ts`), `editor/external-batch.ts` (validate +
  re-mint), 8-line hookup in `BlockTree.tsx` (+ `runStructural` places the caret when focus stays
  on the edited block), `data/templates.ts` builds ops without applying, command commits them.
  Tests `e2e/tests/template-undo.spec.ts` (both failed before), unit tests. ADR 019 amended.
  B-191 logged (generic property undo limit). Commit: the one after `c510633`.
  e2e run: template-undo + redo + templates + focus = 41/41 passed.

## In flight

- Nothing uncommitted after the B-108 commit.

## Next, in order

1. Failing e2e for B-88: `e2e/tests/editing-row-leaves.spec.ts` — caret in a block, move or
   delete it through the API, the row must go (and nothing typed is lost).
2. Fix B-88 in `BlockTree.tsx`'s tree effect: keep an absent editing row only while it is a local
   creation no refetch has seen yet; otherwise flush, detach, end editing. Remove `leaveEditing`
   from `commands/registrations/refactor.ts` and its test expectations; rerun `refactor.spec.ts`.
3. Rerun the specs that exercise optimistic creation: focus, editing, selection, parity,
   templates, template-undo, redo, refactor, context-menu, journals.

## Decisions

- B-108 seam is a typed `EditorHost.commitOps(batch): boolean`, not a stringly
  `runStructuralCommand("block.insertOps")`: the command needs to know whether a tree took the
  batch, so it can fall back to `applyOps` rather than lose the insertion.
- The tree re-mints a command's ops: `runStructural` flushes pending keystrokes first, and a
  flushed `block.text` stamped after the command's ops would win LWW over the batch's own text.
- B-190 fixed editor-side (a revive op after each redone create), not by making core's
  `block.create` revive tombstones — that would change op-log replay semantics everywhere.
- `template-undo.spec.ts` deletes its template library after each test: specs share one server
  and `templates.spec.ts` asserts the exact Settings template list (it went red when it didn't).

## How to resume

`git log --oneline da85cfb..m8/impl-editor`, then this file's Next list. e2e:
`cd e2e && NOOKLET_E2E_PORT=6405 pnpm exec playwright test <specs> --project=chromium`.
