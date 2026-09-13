# qafix-m8-views — fixing exploratory-QA findings on the M8 views (real graph, phone width)

Branch `m9/qafix-m8-views`, worktree `.claude/worktrees/wf_e473942f-106-16`, based on `cf08d19`.
e2e port 6461. Bugs go to `docs/bugs-inbox/qafix-m8-views.md` (B-350..B-359), not BUGS.md.
Scratch: `$SCRATCH/m9/qafix-m8-views/` (SCRATCH = the session scratchpad).

Findings: Q1 page title clipped at 390px (medium, B-350 + existing B-225); Q2 block context menu
off-screen in the lower half (medium, B-351); Q3 no touch route to the command palette (medium,
B-352); Q4 cleared search keeps stale results (low, B-353); Q5 ISO journal names in search and
replace (low, B-354); Q6 search filter order splits the date range (low, B-355).

## Done

(nothing yet)

## In flight

- All six logged in the inbox. Starting Q1.

## Next steps

Q1 → Q2 → Q3 → Q4 → Q5 → Q6, one commit each, each with its failing test first.

## How to resume

`git log --oneline cf08d19..HEAD`; each finding is one commit naming its Q-id and B-number.
