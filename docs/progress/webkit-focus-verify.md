# M11 progress — webkit-focus VERIFY (adversarial review of m11/webkit-focus)

Branch `m11/webkit-focus` (worktree `.claude/worktrees/wf_b8e786c1-020-1`), reviewing commits
57985f6..14229ef on top of 52e5d20. E2E port 6416. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/webkit-focus-verify/`.
New bug numbers available: B-502..B-509 (B-501 used by the author).

## Done

(nothing yet)

## In flight

- Running the branch's new e2e specs in chromium + webkit (machine load average ~70-97).

## Next

1. Independent repro attempt of B-42 in WebKit with scenarios the author did not try.
2. Review focus-log.ts for behaviour changes when on (prototype patches), privacy leaks.
3. Own test for the riskiest edge.
