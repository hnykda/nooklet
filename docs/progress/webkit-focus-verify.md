# M11 progress — webkit-focus VERIFY (adversarial review of m11/webkit-focus)

Branch `m11/webkit-focus` (worktree `.claude/worktrees/wf_b8e786c1-020-1`), reviewing commits
57985f6..14229ef on top of 52e5d20. E2E port 6416. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/webkit-focus-verify/`.
New bug numbers available: B-502..B-509 (B-501 used by the author).

## Done

- Branch's new e2e (webkit-refresh-focus, focus-log) on HEAD: 10/10 chromium+webkit (load avg ~80).
- Test-merge: clean with main and all m11 branches except m11/ref-label-flash (trivial conflict in
  e2e/playwright.config.ts webkit testMatch regex — union both).
- Own probe `e2e/verify-probes/refresh-focus-structural.spec.ts` (temporary location; to be kept in
  tools/probes/): 7 scenarios x 2 engines against a server on 6416. FINDING: `move-edited-block` —
  another writer moves the block being edited (row DOM moves on refresh) — in WebKit the caret
  jumps 57 -> 0 with the popup left open and the next key lands at the START ("gbase ...");
  Chromium keeps 59 and appends. No focusout in WebKit, 1 DOM op on the focused subtree. Same
  family as the author's B-501 (Alt+Up/Down). Traces in scratch traces/structural/.

## In flight

- Evidence for the mechanism in WebKit (activeElement / selection right after the DOM move,
  focus() calls, selectionchange).

## Next

1. Diagnose + fix (small BlockTree/surface hunk), e2e that fails in WebKit before and passes after.
2. Review focus-log.ts for behaviour changes when on (prototype patches), privacy leaks.
