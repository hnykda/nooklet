# qafix-views — fixing exploratory-QA findings on the M7 views (real graph)

Branch `m8/qafix-views`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-22`, based on `da85cfb`.
e2e port 6461. Bugs go to `docs/bugs-inbox/qafix-views.md` (numbers B-250..B-259), not BUGS.md.

Findings Q1–Q6 (from the M8 QA run over the M7 views): Q1 replace-all uses a stale debounced
input (high); Q2 history restore/undo overwrites later edits (high); Q3 references panel silently
capped at 200/50 (medium); Q4 turn-into-page keeps `##` in the page name (medium); Q5 trash restore
name conflict is a UI dead end (medium); Q6 trash restore ignores aliases (low).

## Done

- Q1 (B-250) Replace all from live fields, gated on a current preview — see git log for the hash.

## In flight

- Q2: starting — reading batch-undo.ts, HistoryView.tsx, ADR 013.

## Next, in order

Q2 → Q3 → Q4 → Q5 → Q6.

## How to resume

`git log --oneline da85cfb..HEAD` on this branch; each finding is one commit naming its Q-id.
