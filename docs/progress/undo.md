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

- `e0da57d` R51 as built (`docs/spec/commands-and-keymap.md`, four lines), real-graph probe
  `tools/probes/undo-real-graph.spec.ts`.
- (this commit) Verification, all on the branch head:
  - Full e2e in two runs on port 6400 (the machine was loaded: the second took 16.7 min).
    `tests/[a-o]`: 157 passed, 1 skipped (pre-existing skip). `tests/[p-z]`: 289 passed, 1 skipped,
    2 failed — `popups.spec.ts` "Code block wraps the content in a fence" (passed on rerun: 71/72
    for popups + views) and `views.spec.ts` "opening the palette while editing and closing it hands
    focus back to the editor", which fails again alone AND with `apps/web/src` checked out at
    `cf08d19` — the pre-existing B-161 family (B-173/B-193/B-213/B-226/B-246/B-270), not this
    branch. Total 446 passed of 450 in the full pass, 448 counting the rerun.
  - Real graph (backup of `~/.nooklet/default`, served on port 6419 with `NOOKLET_DATA` in
    scratch): the probe passes 2/2 — palette priority, Cmd/Ctrl+Enter and a collapse of a 35-child
    block undone on "Deciding on a Bike" (55 rows), editor kept; a chip date on journal 2022-12-16
    undone. `pnpm nooklet verify` on that copy afterwards: OK (20423 ops replayed).

## 2. In flight

Nothing. Task complete on this branch.

## 3. Next steps, in order

None for this brief. For the coordinator: B-194's "should an undo reach a block that left?" was
answered "no" here and needs the owner's confirmation (see the inbox entry for how to flip it).

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

## 6. Adversarial verification (second agent, 2026-09-13)

Scratch `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/undo-verify/`, e2e port 6400.

- Re-ran: web unit 1015/1015, `pnpm -r typecheck` 0, biome clean on touched files;
  `undo-gaps.spec.ts` 9/9 (the spec has 9 tests, not the 10 reported above).
- Browser probes (throwaway spec, not kept), all at the branch head: repeat-aware DOING→DONE via
  Cmd/Ctrl+Enter undone and redone (marker, scheduled, done all restored on the server); selection
  mode Cmd/Ctrl+Enter undo/redo keeps the selection; an unflushed property-line edit then
  Cmd/Ctrl+Enter undoes in two steps (`kind:: ab` → `kind:: a`); a remote `block.delete` of the
  last-edited block drops that step and undoes the older one; Czech + emoji text survives a date
  undo; cross-tree chip pick with editing in another day is undone correctly. Rapid double
  Cmd/Ctrl+Enter reads a stale marker (TODO twice) — the same on `cf08d19`, not this branch.
- Found and fixed **B-281** (`9546dff`): a block left selected in another journal day kept its
  tree the undo target over the tree that took a chip date. New e2e test in `undo-gaps.spec.ts`,
  unit test in `editor-host.test.ts`.
