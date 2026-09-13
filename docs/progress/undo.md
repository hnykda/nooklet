# M9 · undo — progress log

Agent task: undo gaps in the editor. B-142 (a date set with the picker, and by reading priority and
palette marker commands, are not undoable — route store-written task commands through the tree's
history), B-191 (undo of `/template` into a bullet that already had one of the template's
properties removes it), B-194 (Cmd/Ctrl+Z after the edited block left the page reverts it out of
sight and unmounts the editor), B-162 (undoing a collapse ends editing, so redo has no keyboard
target). Failing Playwright test first for each.

Branch `m9/undo` from `cf08d19`, worktree
`<repo>/.claude/worktrees/wf_e473942f-106-5`. e2e port 6400. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/undo/`.
Bugs go to `docs/bugs-inbox/undo.md` (never `docs/BUGS.md`).

## 1. Done (commit hashes)

- (this commit) B-142 fixed + B-191 verified fixed by B-101: `app/hosts.ts#createStore` writes
  block props through `EditorHost.commitOps`; `app/editor-host.ts#commitThroughEditor` tries the
  active, recent, then every mounted tree (`registerEditorHost` in `BlockTree`). Tests:
  `e2e/tests/undo-gaps.spec.ts` (B-142 ×3, B-191 ×1), `hosts.test.ts` +3, `editor-host.test.ts` +3.
  Base run of the full new spec (7 tests incl. B-194/B-162, kept in scratch until their fix):
  6 failed, 1 passed (B-191). After the change: B-142 3/3; dates, tasks, templates,
  template-undo, undo-redo, redo, selection 55/55; web unit 1006/1006; typecheck clean.

## 2. In flight

- B-194 + B-162 tests: the full spec with them is at
  `<scratch>/undo-gaps.full.ts` (lines 219-302); re-add them to `e2e/tests/undo-gaps.spec.ts`.

## 3. Next steps, in order

1. B-162 + B-194: `BlockTree` undo/redo keep the editor where it is when the recorded focus is
   null or names a block with no row; `EditHistory` drops entries whose blocks left the tree;
   collapse / collapse-all / keyboard task.cycle record the editing caret as focus.
2. Run the spec plus undo-redo, redo, focus, editing, editing-row-leaves, commands, template-undo,
   selection, tasks. Unit: history.test.ts.
3. Final: `pnpm nooklet verify` is not needed (no ops/sync/schema change) unless that changes.

## 4. Decisions (and why)

- **B-142's seam is the Store, not the commands.** Every store-routed write (task commands, date
  picker) goes through one function, so no command can forget. Commands stay host-agnostic.
- **A batch may go to a mounted tree that is not focused** and that tree becomes the undo target.
  Needed for chip clicks (nothing focused). A tree only takes a batch for a block it shows.
- **Palette focus not asserted.** The palette does not hand focus back to the editor on close —
  the known B-270 family, not this task; the tests press Cmd/Ctrl+Z through the global dispatcher.

## 5. How to resume

`git log --oneline cf08d19..m9/undo` in the worktree; this file's section 1 names each commit.
Run `cd e2e && NOOKLET_E2E_PORT=6400 pnpm exec playwright test tests/undo-gaps.spec.ts --project=chromium`.
