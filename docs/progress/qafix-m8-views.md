# qafix-m8-views — fixing exploratory-QA findings on the M8 views (real graph, phone width)

Branch `m9/qafix-m8-views`, worktree `.claude/worktrees/wf_e473942f-106-16`, based on `cf08d19`.
e2e port 6461 (also the probe server's port when no e2e run is going). Bugs go to
`docs/bugs-inbox/qafix-m8-views.md` (B-350..B-359), not BUGS.md.
Scratch: `$SCRATCH/m9/qafix-m8-views/` (SCRATCH = the session scratchpad): `e2e.sh <specs>` runs
specs on 6461; `pristine/graph.sqlite` is the real-graph backup (copy into `graph/` for a probe);
`title.mjs`, `menu.mjs` are the Q1 probes (need a server on 6461 serving `graph/`).

Findings: Q1 page title clipped at 390px (medium, B-350 + existing B-225); Q2 block context menu
off-screen in the lower half (medium, B-351); Q3 no touch route to the command palette (medium,
B-352); Q4 cleared search keeps stale results (low, B-353); Q5 ISO journal names in search and
replace (low, B-354); Q6 search filter order splits the date range (low, B-355).

## Done

- Logged all six first: `8afa483`.
- Q1 (B-350, B-225) — title is a growing textarea (`views/PageTitleField.tsx`, `views/page-title.css`);
  hover-only icon slot and History link leave the row under `(hover: none)`; "…" menu gains
  Add/Change icon + Page history (`PageActions.tsx`, `PageIcon.tsx#requestPageIconEdit`).
  Test `e2e/tests/page-title-fit.spec.ts` (5; 4 failed before). Nearby specs: 60 passed, 1 failed
  once then passed on rerun (page-icons race, logged B-356). Web unit 1000/1000 (one load timeout
  on the first run, clean rerun). Real graph probe: all four long names unclipped, phone + desktop.

## In flight

- Q2 next.

## Next steps

Q2 → Q3 → Q4 → Q5 → Q6, one commit each, each with its failing test first.

## Decisions

- Q1: a textarea rather than hiding more controls — hiding alone leaves any name over ~21
  characters clipped on a phone and 36+ at desktop. Hover-only controls are removed only where
  hover does not exist, and get menu twins on every device (discoverability was B-225's complaint).

## How to resume

`git log --oneline cf08d19..HEAD`; each finding is one commit naming its Q-id and B-number.
