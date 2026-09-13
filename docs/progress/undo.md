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

- `35ff441` B-142 fixed + B-191 verified fixed by B-101: `app/hosts.ts#createStore` writes
  block props through `EditorHost.commitOps`; `app/editor-host.ts#commitThroughEditor` tries the
  active, recent, then every mounted tree (`registerEditorHost` in `BlockTree`). Tests:
  `e2e/tests/undo-gaps.spec.ts` (B-142 ×3, B-191 ×1), `hosts.test.ts` +3, `editor-host.test.ts` +3.
  Base run of the full new spec (7 tests incl. B-194/B-162): 6 failed, 1 passed (B-191; it fails
  with `invert.ts#propValueBefore`'s default put back to `null`). After the change: B-142 3/3;
  dates, tasks, templates, template-undo, undo-redo, redo, selection 55/55; web unit 1006/1006.
- `6628f12` B-194, B-162, B-280 fixed: `history.ts` undo/redo take `present(id)` and drop
  steps on blocks that left (`reachable`); new `editor/undo-focus.ts#focusAfterStep` (follow a
  caret only into a block with a row; no caret → keep the editor while its row is on screen);
  `BlockTree#applyHistoryStep` shared by `doUndo`/`doRedo`; `BlockTree#commitStep` flushes typing
  first (collapse/expand, keyboard task.cycle, marker click). Tests: undo-gaps.spec.ts 10/10 (B-194
  ×1, B-162 ×2, B-280 ×2 added), history.test.ts +4, undo-focus.test.ts 5. B-194/B-162 e2e failed
  on the base; the B-280 collapse test failed before `commitStep`. Wide e2e (undo-gaps, undo-redo,
  redo, focus, editing, editing-row-leaves, commands, template-undo, selection, tasks, dates,
  block-properties, journal-stream-editing, page-find, read-only): 131/131. Web unit 1015/1015.

## 2. In flight

- Full e2e in two runs on port 6400: `tests/[a-o]` done — 157 passed, 1 skipped (the pre-existing
  skip). `tests/[p-z]` running; one failure so far, `popups.spec.ts` "Code block wraps the content
  in a fence" (fence missing after an immediate reload) — rerun that spec alone before judging.
- Uncommitted: `docs/spec/commands-and-keymap.md` R51 gains four lines (store commands are undo
  steps; steps on blocks that left are dropped; null caret keeps the editor);
  `tools/probes/undo-real-graph.spec.ts` (real-graph probe, not run yet).

## 3. Next steps, in order

1. Finish the `[p-z]` run; rerun any failing spec once (load until proven otherwise).
2. Real-graph probe: backup at `<scratch>/graph/graph.sqlite`; serve it on 6401 with
   `NOOKLET_DATA=<scratch>/data`; copy the probe into `e2e/tests/`, run with
   `NOOKLET_E2E_URL=http://127.0.0.1:6401`, delete the copy, kill 6401.
3. Commit spec note + probe + progress.
4. `pnpm nooklet verify` is not needed: no ops/sync/schema change (the ops written are the same
   kinds, only routed through the tree).

## 4. Decisions (and why)

- **B-142's seam is the Store, not the commands.** Every store-routed write (task commands, date
  picker) goes through one function, so no command can forget. Commands stay host-agnostic.
- **A batch may go to a mounted tree that is not focused** and that tree becomes the undo target.
  Needed for chip clicks (nothing focused). A tree only takes a batch for a block it shows.
- **Palette focus not asserted.** The palette does not hand focus back to the editor on close —
  the known B-270 family, not this task; the tests press Cmd/Ctrl+Z through the global dispatcher.
- **B-194: an undo does not reach a block that left the tree (owner's call, flagged).** Steps on
  it are dropped, not skipped-and-kept. Reversible in two call sites (`present` in doUndo/doRedo).
- **B-162: changed the rule, not the call sites.** "No recorded caret" now means "keep the editor
  while its row exists", instead of recording carets for collapse, collapse-all and marker commits.
  One rule covers every null-focus step, including ones the entry did not list.
- **B-280 logged and fixed here**: found while reading `commitOne` for B-162, two lines, own test.

## 5. How to resume

`git log --oneline cf08d19..m9/undo` in the worktree; this file's section 1 names each commit.
Run `cd e2e && NOOKLET_E2E_PORT=6400 pnpm exec playwright test tests/undo-gaps.spec.ts --project=chromium`.
