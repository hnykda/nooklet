# qafix-views — fixing exploratory-QA findings on the M7 views (real graph)

Branch `m8/qafix-views`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-22`, based on `da85cfb`.
e2e port 6461 (also used for probe servers when no e2e run is going). Bugs go to
`docs/bugs-inbox/qafix-views.md` (numbers B-250..B-259), not BUGS.md.

Findings Q1–Q6 (from the M8 QA run over the M7 views): Q1 replace-all uses a stale debounced
input (high); Q2 history restore/undo overwrites later edits (high); Q3 references panel silently
capped at 200/50 (medium); Q4 turn-into-page keeps `##` in the page name (medium); Q5 trash restore
name conflict is a UI dead end (medium); Q6 trash restore ignores aliases (low).

## Done

- Q1 (B-250) `bd68e87` — Replace all from live fields, gated on a preview of exactly those fields.
  `e2e/tests/replace-stale.spec.ts` (2 tests, both failed before).
- Q2 (B-251) `f0d2f77` — `batch.undo` `keep_later_edits` + `ignore_batches` (per-field, `ops/later-edits.ts`),
  `kept` in the result; History Undo/Restore use them and name kept pages
  (`views/keptEdits.ts`). Tests: `e2e/tests/history-later-edits.spec.ts` (2, both failed before),
  `packages/server/src/ops/batch-undo-later-edits.http.test.ts` (6), `keptEdits.test.ts` (4).
  Real graph: `tools/probes/history-keep-later-edits.mjs` → OK (533-block replace of "Alex",
  later edit on 2022-12-09 kept while restoring 2022-12-13); `verify` OK, 30,581 ops. Spec
  §4.3.17 + ADR 022 amendment. Found in passing: B-252 (`old_str` fails on blocks with
  properties) — logged, not fixed.

- Q3 (B-253) `58e7b85` — client follows `page.backlinks` cursor (500/page, cap 5000); server
  `unlinked_limit` (default 50, panel 500) + `unlinked_truncated` + `linked_total`; panel renders
  200 rows + "Show more" (`views/referenceWindow.ts`). Tests: `e2e/tests/references-cap.spec.ts`
  (failed before: 200 vs 205), `page-backlinks-totals.http.test.ts` (3), `referenceWindow.test.ts`
  (4). Real graph: CAMP 836/189, @Alex 756/465 match the API.

- Q4 (B-254) `15a98ac` — `block.to_page` names the page by `pageNameFromFirstLine`: heading marker off the
  name (kept on the link block), inline links reduced to their text, sole link (with label) names
  that page. Test: `block-to-page-name.test.ts` (4, all failed before). Real graph copy:
  Megapage `## Plánování…` → existing page, `created: false`, block `## [[Plánování…]]`;
  `[[Alex]] by chtěl…` → page `Alex by chtěl něco jako:`; verify OK (20,421 ops).

- Q5 (B-255) `7d30652` — Trash: a page restore refused with `conflict` opens `TrashRenameForm` on the row
  (prefilled "X (restored)", passes `new_name`); name state lifted into `TrashView`, unchanged
  rows keep their objects across refetches. Test: `e2e/tests/trash-conflict.spec.ts` (2, both
  failed before). Real graph: `@Sam Example` restored under the suggested name from the form.

- Q6 (B-256) — `trash.restore` refuses a name a live page uses as an alias (`livePageAliasing`,
  `assertNameFree`), own name and `new_name`. Tests: `trash-restore-alias.http.test.ts` (2; the
  merge case failed before), alias case in `e2e/tests/trash-conflict.spec.ts`. Real graph: merge
  Alex → @Alex, restore Alex → 409, `new_name` works; verify OK.

## In flight

- Final pass: all touched e2e specs in one run, full unit suites, verify on a fresh copy.

## Next, in order

Final pass, then hand back.

## How to resume

`git log --oneline da85cfb..HEAD` on this branch; each finding is one commit naming its Q-id.
Real-graph copy: `$SCRATCH/qafix-views/graph-pristine.sqlite` (copy it into a fresh dir as
`graph.sqlite` before a probe). e2e runner: `$SCRATCH/qafix-views/e2e.sh <specs>`.
