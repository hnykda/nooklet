# Progress — qafix-editor (fix exploratory-QA editor findings Q1-Q6)

Branch `m8/qafix-editor`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-16`,
based on `da85cfb` (the worktree was created at an older commit, 41666ee; the branch was reset to
da85cfb before any work). E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/qafix-editor/`.
QA scripts that found these: `.../scratchpad/qa-editor/t1.mjs`..`t12.mjs` (hardcoded to port 6450).

Bugs go to `docs/bugs-inbox/qafix-editor.md` (NOT `docs/BUGS.md`), numbers B-240..B-249.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 redo of undone create never reaches server | B-240 | high | fixed (first commit) |
| Q2 Cmd+Z after deleting a selection does nothing | B-241 | high | fixed (second commit) |
| Q3 undo of Alt+Up/Down drops focus | B-242 | medium | fixed (third commit) |
| Q4 cold client: journal draft text lost when pull says today exists | B-243 | medium | fixed (fourth commit) |
| Q5 cold client: `[[` New page writes `]]` to DB not editor | B-244 | medium | todo |
| Q6 Cmd+X on selection does nothing | B-245 | low | feature gap: logged, skipped |

## 1. Done (committed)

- Q1/B-240 `fix(web): redo of an undone new block revives its tombstone`:
  `apps/web/src/editor/invert.ts#redoRecipe` (create -> undelete), `history.ts#redo` maps forward
  through it. Unit: `history.test.ts` (updated assertion + real-SQLite round trip; both fail
  without the fix). E2E `e2e/tests/undo-redo.spec.ts` failed before, passes after; with
  `focus.spec.ts` 31/31 on 6460. Web unit 685/685, typecheck clean.

- Q1/B-240 committed as `f7ea0f6`.
- Q2/B-241 `fix(web): undo and redo still reach the page after its editing session ends`:
  `apps/web/src/app/editor-host.ts` (`historyEditorHost`, `releaseEditorHost`; `liveEditorHost`
  routes `edit.undo`/`edit.redo` through the fallback), `BlockTree.tsx` (2 lines in the host
  backing's `runStructural`, cleanup calls `releaseEditorHost`). Tests: 3 new e2e in
  `undo-redo.spec.ts` (failed 3/3 before), 2 unit in `editor-host.test.ts`. E2E undo-redo +
  selection + focus + phone + context-menu: 71 passed, 1 skipped (pre-existing skip).

- Q2/B-241 committed as `fdddec7`.
- Q3/B-242 `fix(web): undo and redo of a block move keep the editor focused`: `BlockTree.tsx`
  `refocusAfterReorder` (extracted from `doMoveStep`), called in `doUndo`/`doRedo`'s
  same-block branch. 2 e2e tests in `undo-redo.spec.ts` (failed 2/2 before). E2E undo-redo +
  focus + selection + editing + parity: 72/72.

- Q3/B-242 committed as `9a19de3`.
- Q4/B-243 `fix(web): text typed into a journal draft survives the draft being swapped out`:
  new `apps/web/src/data/journal-day.ts` (`appendToJournalDay`), `views/VirtualJournalDay.tsx`
  cleanup keeps an uncommitted draft (+ `disposed` guard on blur). 4 unit tests in
  `VirtualJournalDay.test.tsx`; e2e `e2e/tests/journal-draft-sync.spec.ts` holds `/sync/snapshot`
  with `page.route` (failed before, 3/3 after). E2E a-fresh-journal + editing + journal-draft-sync
  + pages + templates + views + storage: 57 passed, 1 failed, 1 skipped; the failure is
  `views.spec.ts` palette focus, which also fails with `apps/web/src` at da85cfb (logged B-246).
- Side bug logged, not fixed: B-246 (above).

## 2. In flight

- (nothing)

## 3. Next steps, in order

1. (done) Q1, Q2, Q3, Q4.
2. Unverified side observation, not fixed: the global keydown dispatcher matches `edit.undo`
   (`when: "true"`) and preventDefaults it everywhere, so native Cmd+Z inside a plain `<input>`
   (search, page title) is probably swallowed. Probe it before logging as a bug.
3. Q5 (B-244): popup New page during initial pull. Needs a slow-pull fixture.

## 4. How to resume

`git log --oneline da85cfb..` for what landed; the table above for what is left. E2E:
`cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test tests/<spec> --project=chromium`.
