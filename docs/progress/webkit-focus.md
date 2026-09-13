# M11 progress — webkit-focus (B-42 in WebKit on sync refresh)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Branch `m11/webkit-focus`, worktree `<repo>/.claude/worktrees/wf_b8e786c1-020-1`,
based on `52e5d20`. E2E port 6416. Bug entries go to `docs/bugs-inbox/webkit-focus.md` (new
numbers B-501..B-509), never `docs/BUGS.md`. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/webkit-focus/`
(traces in `traces/`; graph copy in `graph/`; a server on that copy may be running on 6416 —
`lsof -iTCP:6416 -sTCP:LISTEN` and kill it before an e2e run, which needs the port).

Brief: owner (2026-09-13) — focus loss while the `[[` autocomplete is open reproduces in the
desktop app (Tauri/WKWebView) on a sync refresh, not in Chromium. Reproduce in Playwright WebKit
with a focus trace across refresh kinds (own push/pull, poke from another writer same page / other
page, push-queue drain), find the cause, fix it, e2e spec in both projects. If WebKit does not
reproduce: say so, add owner-usable focus instrumentation, stop.

## 1. Done (committed)

(nothing yet)

## 2. Findings so far (not yet committed)

- Probe `tools/probes/webkit-refresh-focus.spec.ts` (a copy ran as
  `e2e/tests/zz-probe-webkit-refresh-focus.spec.ts` with the webkit testMatch widened — both
  temporary, remove before committing).
- Result 1 (small e2e graph, headless): NOT reproduced in WebKit or Chromium. Five scenarios
  (existing block own-cycle / API write same page / API write other page; new block by Enter
  own-cycle / API same page): popup open, 0 samples unfocused over 2.5-3 s, `x` typed after lands,
  0 focusout, 0 DOM ops on the focused subtree in either engine.
- Result 2 (copy of the real graph, 953 pages / 18,631 blocks, served on 6416 with
  `--no-mirror`; probe `tools/probes/webkit-refresh-focus-real-graph.mjs`, headless): NOT
  reproduced. WebKit and Chromium, today's journal (which on the owner's graph holds
  `((1m287mdbqzg37p))` = "travel/trip-planning"; the B-500 flash is visible in the trace, so the
  refreshes did happen): own-cycle, new block by Enter, API write same page, API write other page,
  day started from the draft (browser clock shifted to a day with no page). WebKit variants:
  pointer resting on the popup / below the editor, rAF delayed 120 ms, 700 ms between keys.
  Every run: 0 unfocused samples, `x` typed afterwards lands, 0 focusout in WebKit.
- Headed WebKit NOT run: it opens a window that takes OS keyboard focus while the owner is
  typing in the desktop app on this machine.
- DECISION (task step 4): no fix. Build instrumentation the owner can switch on in the desktop
  app (Diagnostics panel toggle, copyable log), plus a guard e2e for the reported scenario in both
  projects.

## 3. Next steps

1. `apps/web/src/app/focus-log.ts` recorder (flag in localStorage, ring buffer, DOM-level hooks:
   focusin/out, window blur/focus, visibilitychange, focus()/blur() calls, DOM ops on the focused
   subtree, 50 ms activeElement/editor/popup poll, keydown category, composition, beforeinput
   inputType, pointerdown target; app notes: replica change events, sync status, surface
   attach/detach). No typed text in the log. Kept across a reload.
2. Diagnostics panel section: toggle, count, Copy, Clear, readonly textarea.
3. Unit test for the recorder; e2e `webkit-refresh-focus.spec.ts` (guard, both projects) and a
   Diagnostics focus-log e2e.
4. Inbox entry for B-42 (existing): not reproduced in Playwright WebKit, what was ruled out, how
   the owner records a log.
