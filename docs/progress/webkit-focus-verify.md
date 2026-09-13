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

- Mechanism traced (probe tools/probes/edited-row-move-mechanism.spec.ts): WebKit fires no focusout
  on the move, CM6 keeps a stale cached DOM selection, view.focus() writes nothing, WebKit's focus
  leaves the caret at 0. Logged B-502 + failing test `40fc589`.
- Fix `3973aa1` in editor/surface.ts#focus (write state selection to DOM if they disagree; no
  BlockTree hunk). Against a probe server: edited-row-move-caret chromium 2/2 + webkit 2/2.
- B-503 (focus log logged emoji/decomposed accents as typed) fixed `c665747`, unit 8/8.
- `6034ec1` tests: undo of Alt+Up caret; focus log ON changes nothing about editing (both engines).

## In flight

- Proper e2e runs (global setup, port 6416): before-fix (surface.ts from 40fc589) and after-fix for
  edited-row-move-caret + focus-log + webkit-refresh-focus in both projects; then the broad list
  in chromium and webkit (temp config without testMatch, deleted after).

## Next

1. Report. Remaining notes: playwright.config.ts conflict with m11/ref-label-flash (union regex).
