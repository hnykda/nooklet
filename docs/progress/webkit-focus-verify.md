# M11 progress — webkit-focus VERIFY (adversarial review of m11/webkit-focus)

Branch `m11/webkit-focus` (worktree `.claude/worktrees/wf_b8e786c1-020-1`), reviewing commits
57985f6..14229ef on top of 52e5d20. E2E port 6416. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/webkit-focus-verify/`
(traces/, e2e-*.txt run outputs, typing-cost.txt). Bug numbers used: B-502, B-503.

## Done

- Branch's own e2e on its HEAD: webkit-refresh-focus + focus-log 10/10 (chromium + webkit).
- Test-merge: clean with main and every m11 branch except m11/ref-label-flash — one trivial
  conflict in e2e/playwright.config.ts (both widen the webkit testMatch regex; take the union).
- B-42 still NOT reproduced (independent probe `tools/probes/refresh-focus-structural.spec.ts`,
  7 structural refreshes incl. a real second client and typing through remote inserts).
- Found B-502 (WebKit only): a refresh that MOVES the edited block → caret 0, `[[` popup left open,
  next key at block start. Mechanism traced (`tools/probes/edited-row-move-mechanism.spec.ts`):
  WebKit fires no focusout on the move, CM6's cached DOM selection goes stale, view.focus() writes
  nothing, WebKit's focus leaves the caret at 0. Same cause as the branch's B-501 (Alt+Up/Down).
  - `40fc589` log + failing test; `3973aa1` fix in editor/surface.ts#focus (no BlockTree hunk).
- B-503: focus log logged emoji / decomposed accents as typed keys — fixed `c665747`.
- Tests `6034ec1`, `81d602a`, mid-line test commit: undo of Alt+Up (guard), hidden-marker mid-line
  caret (guard), focus log ON changes nothing about editing (fails pre-fix in WebKit).
- Measurements (port 6416, global setup):
  - pre-fix surface.ts, edited-row-move-caret + focus-log + webkit-refresh-focus: 15 passed,
    3 failed (all webkit, caret 0). Fixed: 18/18; with the mid-line test, edited-row-move-caret 8/8.
  - broad chromium (popups focus focus-return editing editing-row-leaves autocomplete* follow-link-popup
    journal-stream-editing diagnostics storage webkit-refresh-focus focus-log edited-row-move-caret
    context-menu undo-redo remote-device selection): 153 passed, 2 skipped.
  - same list webkit (temp config without testMatch, deleted): 145 passed, 9 failed, 1 skipped —
    5 in-memory-replica reload failures (fail pre-fix too, spot-checked), 4 clipboard specs failing
    at `grantPermissions: Unknown permission: clipboard-write` (Playwright WebKit harness). focus.spec
    Alt+Up/Down (B-501) now passes in webkit (failed pre-fix).
  - apps/web vitest 1146/1146; pnpm -r typecheck exit 0.
  - Focus log typing cost probe `tools/probes/focus-log-typing-cost.spec.ts`: within noise, no lost keys.

## Not done / notes for the coordinator

- B-502's fix is verified in Playwright WebKit only, not in the desktop app's WKWebView.
- Focus log: after switching it off and on again later, "previous page load" shows the stale log of
  whatever load last recorded (PREVIOUS_KEY is never cleared on disable). Cosmetic; not fixed.
- The owner's B-42 remains unreproduced; the log is still the next step.

## In flight

(nothing)
