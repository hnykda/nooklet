# Progress — qafix-editor (fix exploratory-QA editor findings Q1-Q6)

Branch `m8/qafix-editor`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-16`,
based on `61279a2` (the worktree was created at an older commit, f7c9644; the branch was reset to
61279a2 before any work). E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/qafix-editor/`
(real-graph copy in `graph/`, QA-script copies pointed at 6460, probes `q5.mjs`, `busy.mjs`,
`leader.mjs`, `reloadloss.mjs`, `busyreload.mjs`). QA scripts that found these:
`.../scratchpad/qa-editor/t1.mjs`..`t12.mjs` (hardcoded to port 6450).

Bugs go to `docs/bugs-inbox/qafix-editor.md` (NOT `docs/BUGS.md`), numbers B-240..B-249; used
B-240..B-247.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 redo of undone create never reaches server | B-240 | high | fixed `c40476b` |
| Q2 Cmd+Z after deleting a selection does nothing | B-241 | high | fixed `c0f9013` |
| Q3 undo of Alt+Up/Down drops focus | B-242 | medium | fixed `7e5faac` + refetch follow-up |
| Q4 cold client: journal draft text lost when pull says today exists | B-243 | medium | fixed `a264325` |
| Q5 cold client: `[[` New page writes `]]` to DB not editor | B-244 | medium | fixed `7875bd9` |
| Q6 Cmd+X on selection does nothing | B-245 | low | feature gap: logged, skipped |
| (found) views.spec palette-focus test fails at 61279a2 | B-246 | low | logged, not investigated |
| (found) edit queued behind busy worker lost on reload | B-247 | high | logged + probe `fb12557` |

## 1. Done (committed)

- `c40476b` Q1/B-240: `apps/web/src/editor/invert.ts#redoRecipe` (create -> undelete),
  `history.ts#redo` maps forward through it. Unit: `history.test.ts` (updated assertion +
  real-SQLite round trip; both fail without the fix). E2E `e2e/tests/undo-redo.spec.ts` failed
  before, passes after.
- `c0f9013` Q2/B-241: `apps/web/src/app/editor-host.ts` (`historyEditorHost`,
  `releaseEditorHost`; `liveEditorHost` routes `edit.undo`/`edit.redo` through the fallback),
  `BlockTree.tsx` (2 lines in the host backing's `runStructural`; cleanup calls
  `releaseEditorHost`). 3 e2e in `undo-redo.spec.ts` (failed 3/3 before), 2 unit in
  `editor-host.test.ts`.
- `7e5faac` Q3/B-242: `BlockTree.tsx#refocusAfterReorder` (extracted from `doMoveStep`), called
  in `doUndo`/`doRedo`'s same-block branch. 2 e2e tests (failed 2/2 before).
- `a264325` Q4/B-243: new `apps/web/src/data/journal-day.ts` (`appendToJournalDay`),
  `views/VirtualJournalDay.tsx` cleanup keeps an uncommitted draft (+ `disposed` guard on blur).
  4 unit tests; e2e `e2e/tests/journal-draft-sync.spec.ts` holds `/sync/snapshot` with
  `page.route` (failed before, 3/3 after). Also logs B-246.
- `7875bd9` Q5/B-244: `commands/autocomplete/AutocompletePopup.tsx` inserts + dismisses
  synchronously, creates the page in the background. Unit test (fails without the fix); e2e
  `e2e/tests/autocomplete-busy-replica.spec.ts` busies the db worker with `worker.evaluate`
  (failed before, 3/3 after). Verified with QA's `t2.mjs` on a real-graph copy.
- `fb12557` B-247 entry + `tools/probes/busy-replica-reload.mjs` (verified: reload while busy ->
  `x`, reload after busy -> `x queued`).
- `6117ec4` B-242 follow-up: the refetch effect in `BlockTree.tsx` refocuses the edited block
  when a refetch reorders rows (stale-read flicker, traced). `undo-redo.spec.ts` B-242 tests now
  also check focus 400 ms after undo/redo; without the change Alt+ArrowUp fails, with it 6/6 in
  three runs.
- Next commit: `refocusAfterReorder` only takes back focus that fell to `<body>`, so a refetch
  landing in the same frame as Cmd+K cannot pull focus out of the palette input. undo-redo +
  focus + views + context-menu + help: 81 passed, 1 skipped (views palette-focus B-246 passed in
  that order, fails alone: noted in B-246).

Regression numbers (port 6460, Chromium): 15-spec run before the follow-up: 163 passed, 2 failed
(the Alt+ArrowUp flake that led to the follow-up; parity "Cmd/Ctrl+A" once, passed on rerun),
1 skipped. After the follow-up: undo-redo + focus + parity + selection + editing 72/72. Web unit
692/692 (one run had a 1-test flake in `page-title.test.ts` / `render-seams.test.tsx`, both pass
alone and on rerun). `pnpm -r typecheck` clean.

Final run on `b915252` (port 6460, Chromium, one server): a-fresh-journal, undo-redo,
journal-draft-sync, autocomplete-busy-replica, focus, selection, editing, popups, autocomplete,
journals, context-menu, phone, parity, pages, templates, references, history: **175 passed,
0 failed, 1 skipped** (the pre-existing phone skip). `views.spec.ts` was not in it; its one
failure (B-246) predates this branch. `pnpm nooklet verify` not run: nothing here touches ops,
sync or schema (the one new write path, `appendToJournalDay`, is an ordinary `block.create`
through `applyOps`).

## 2. In flight

- (nothing)

## 3. Next steps, in order

1. Final report. Nothing else queued for this branch.
2. Not done, for whoever picks it up: B-245 (cut) needs a spec line first; B-246 needs a look at
   why the palette-focus test passed on b9023e9; B-247 needs a design for a durable hand-off.
3. Unverified side observation, not logged as a bug: the global keydown dispatcher matches
   `edit.undo` (`when: "true"`) and preventDefaults it everywhere, so native Cmd+Z inside a plain
   `<input>` (search, page title) is probably swallowed. Not probed; whether Playwright's
   synthetic Cmd+Z triggers native input undo at all is itself unverified, so check by hand.

## 4. How to resume

`git log --oneline 61279a2..` for what landed; the table above for what is left. E2E:
`cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test tests/<spec> --project=chromium`.
Specs of this branch: `undo-redo`, `journal-draft-sync`, `autocomplete-busy-replica` (the latter
two use unique names per run; `undo-redo` does not, so no `--repeat-each` there).
