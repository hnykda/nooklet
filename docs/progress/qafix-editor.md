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
| Q2 Cmd+Z after deleting a selection does nothing | B-241 | high | todo |
| Q3 undo of Alt+Up/Down drops focus | B-242 | medium | todo |
| Q4 cold client: journal draft text lost when pull says today exists | B-243 | medium | todo |
| Q5 cold client: `[[` New page writes `]]` to DB not editor | B-244 | medium | todo |
| Q6 Cmd+X on selection does nothing | B-245 | low | feature gap: logged, skipped |

## 1. Done (committed)

- Q1/B-240 `fix(web): redo of an undone new block revives its tombstone`:
  `apps/web/src/editor/invert.ts#redoRecipe` (create -> undelete), `history.ts#redo` maps forward
  through it. Unit: `history.test.ts` (updated assertion + real-SQLite round trip; both fail
  without the fix). E2E `e2e/tests/undo-redo.spec.ts` failed before, passes after; with
  `focus.spec.ts` 31/31 on 6460. Web unit 685/685, typecheck clean.

## 2. In flight

- (nothing)

## 3. Next steps, in order

1. (done) Q1.
2. Q2 (B-241): selection delete -> undo host. Test in `undo-redo.spec.ts`.
3. Q3 (B-242): refocus after undo/redo of a move. Test in `undo-redo.spec.ts`.
4. Q4 (B-243): journal draft unmount must commit its text. Needs a cold-client e2e (fresh
   context + server that already has today).
5. Q5 (B-244): popup New page during initial pull. Needs a slow-pull fixture.

## 4. How to resume

`git log --oneline da85cfb..` for what landed; the table above for what is left. E2E:
`cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test tests/<spec> --project=chromium`.
