# impl-editor progress (m8)

Branch `m8/impl-editor`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-12`, based on `61279a2`
(the worktree was created at an older commit, f7c9644; the fresh branch was reset to `61279a2`
before any work). e2e port 6405. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-editor/`.

Task: B-108 (template insert not undoable) and B-88 (editing row outlives its block). Failing
Playwright test first, then the fix, then remove the refactor-command workaround for B-88.

## Done

- Plan + inbox entries logged (first commit on the branch).
- **B-190** (found writing B-108's redo assertion; pre-existing): redo of an undone create never
  reached the database. `editor/history.ts#redoRecipes` revives each redone create. Test
  `e2e/tests/redo.spec.ts` (failed before, passes after). Commit `9837a47`.
- **B-108**: `/template` is one editor undo step. `EditorHost.commitOps` seam
  (`commands/hosts/editor-host.ts`, `app/editor-host.ts`), `editor/external-batch.ts` (validate +
  re-mint), 8-line hookup in `BlockTree.tsx` (+ `runStructural` places the caret when focus stays
  on the edited block), `data/templates.ts` builds ops without applying, command commits them.
  Tests `e2e/tests/template-undo.spec.ts` (both failed before), unit tests. ADR 019 amended.
  B-191 logged (generic property undo limit). Commit `5734649`.
  e2e run: template-undo + redo + templates + focus = 41/41 passed.

- **B-88**: `BlockTree` ends editing when the edited block leaves the page;
  `editor/unseen-creations.ts` tells a not-yet-committed local creation from a block that left.
  "Move to page…" workaround removed; "Turn into page" keeps ending editing (probe showed the
  stale buffer overwriting the `[[link]]` rewrite) — B-192 logged. Tests
  `e2e/tests/editing-row-leaves.spec.ts` (both failed before), `unseen-creations.test.ts`,
  `refactor.test.ts` updated. Commit `de1d67e`.
  e2e runs after the fix: editing-row-leaves + refactor + focus + editing + selection +
  context-menu = 73 passed, 1 skipped (pre-existing `test.fixme`); parity + popups +
  autocomplete + journals + a-fresh-journal + templates + template-undo + redo + tasks + replace +
  query + phone = 104 passed. Then the other 22 Chromium specs on `de1d67e`, in two runs: 50
  passed; 64 passed, 1 skipped, 1 failed — `views.spec.ts` palette-focus test, which fails the same
  way with `apps/web` at `61279a2` (logged B-193, not this branch's). So every Chromium spec ran
  once against this branch's code: 291 passed, 1 failed (pre-existing), 2 skipped — in four
  separate server runs, not one shared-server full run.

## In flight

- Nothing. Both assigned bugs and B-190 are fixed and committed.

## Next, in order

1. (For whoever merges) one shared-server full e2e run on the merged branch: this branch's specs
   ran in four batches, each on its own server, so cross-spec state was only partly exercised.
2. B-191, B-192, B-193 are open and need nothing more from this branch; B-192 needs an owner
   decision on what wins when an external text rewrite meets unflushed keystrokes.

## Decisions

- B-88 fix distinguishes "never seen by a refetch" from "seen, now missing". Relies on Solid's
  `createResource` dropping superseded fetches (solid-js 1.9.15 `loadEnd`, `if (pr === p)`),
  read in `apps/web/node_modules/solid-js/dist/solid.js`.
- "Turn into page" keeps `leaveEditing` — not a B-88 workaround any more but a guard against
  B-192; probe (temporary spec, deleted) showed `[[Probe kickoff]]` reverted to
  `Probe kickoff typed` without it.
- B-108 seam is a typed `EditorHost.commitOps(batch): boolean`, not a stringly
  `runStructuralCommand("block.insertOps")`: the command needs to know whether a tree took the
  batch, so it can fall back to `applyOps` rather than lose the insertion.
- The tree re-mints a command's ops: `runStructural` flushes pending keystrokes first, and a
  flushed `block.text` stamped after the command's ops would win LWW over the batch's own text.
- B-190 fixed editor-side (a revive op after each redone create), not by making core's
  `block.create` revive tombstones — that would change op-log replay semantics everywhere.
- `template-undo.spec.ts` deletes its template library after each test: specs share one server
  and `templates.spec.ts` asserts the exact Settings template list (it went red when it didn't).

## Verification pass (2026-09-13, a second agent, same worktree and port)

Adversarial check of the three fixes. Verdict: they do what they claim; no defect found in the
branch's code. Evidence, all re-run rather than read from above:

- Unit (apps/web `vitest run`) 74 files / 695 tests passed; `pnpm -r typecheck` clean; biome clean
  on every changed file.
- The five new e2e tests fail against `apps/web` at `61279a2` (5 of 5) and pass on the branch.
- Throwaway probes (not committed; steps in the entries they produced): nested template with a
  marker + property + grandchildren, undo/redo/reload; `template-including-parent:: false` into an
  empty bullet; template then typing then two undos; undo of a Backspace delete then typing; redo
  then typing; keyboard Back to another page while editing (the tree is reused with a new
  `pageId`: no ghost row, text kept); a seen block deleted through the API while typed in;
  template through the palette; a 300-block Czech template undo/redo; "Move to page…" from the
  menu and the palette on the edited row. All behaved. `nooklet verify` OK on that data (1,930
  ops).
- Real-graph copy (952 pages): `/template Meeting` (collapsed, custom props) on the 263-block
  journal 2023-01-11, undo, redo, Czech typing, reload; an agent deleting the block being edited on
  OmnivoreSync (961 blocks). Both right; `nooklet verify` OK (20,480 ops).
- Mutation checks: with `UnseenCreations.has` forced false, 10 editing/focus e2e tests fail (the
  stale-read race it guards is common, not theoretical); with revives not counted as creations,
  only the new "a block brought back by undo keeps its row…" test fails — no earlier e2e covered it.
- Added: two tests in `editing-row-leaves.spec.ts`, one in `template-undo.spec.ts` (named in the
  B-88/B-108 entries). Logged B-194 and B-195 (both pre-existing or edge, low).
- Every Chromium spec again after those additions (`9cf4000`), three server runs: 87 passed +
  1 skipped; 122 passed (views.spec included — B-193's test passed this time); 86 passed +
  1 skipped. Total 295 passed, 0 failed, 2 skipped. WebKit (`storage.spec.ts`): 2 passed.

## How to resume

`git log --oneline 61279a2..m8/impl-editor`, then this file's Next list. e2e:
`cd e2e && NOOKLET_E2E_PORT=6405 pnpm exec playwright test <specs> --project=chromium`.
