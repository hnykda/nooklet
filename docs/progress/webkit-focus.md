# M11 progress — webkit-focus (B-42 in WebKit on sync refresh)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Branch `m11/webkit-focus`, worktree `<repo>/.claude/worktrees/wf_b8e786c1-020-1`,
based on `52e5d20`. E2E port 6416. Bug entries go to `docs/bugs-inbox/webkit-focus.md` (new
numbers B-501..B-509; none used), never `docs/BUGS.md`. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/webkit-focus/`
(traces and dumped focus logs in `traces/`; graph copy in `graph/`).

Brief: owner (2026-09-13) — focus loss while the `[[` autocomplete is open reproduces in the
desktop app (Tauri/WKWebView) on a sync refresh, not in Chromium. Reproduce in Playwright WebKit
with a focus trace across refresh kinds, find the cause, fix it, e2e spec in both projects. If
WebKit does not reproduce: say so, add owner-usable focus instrumentation, stop.

## 1. Done (committed)

- `57985f6` probes — `tools/probes/webkit-refresh-focus.spec.ts` (e2e graph) and
  `tools/probes/webkit-refresh-focus-real-graph.mjs` (copy of the real graph). NOT reproduced in
  Playwright WebKit or Chromium; details in the inbox entry.
- `60b58f6` focus log — `apps/web/src/app/focus-log.ts` (+ 8 unit tests), hooks in
  `data/store.ts` (replica change, sync status), `editor/surface.ts` (attach/detach), `main.tsx`
  (init), Diagnostics panel section (`views/DiagnosticsPanel.tsx`, `diagnostics.css`).
- `2206cfb` e2e — `e2e/tests/webkit-refresh-focus.spec.ts` (3) and `e2e/tests/focus-log.spec.ts`
  (2), both in the webkit project's testMatch. 10/10 in chromium+webkit. Sabotage check: a build
  that blurs on each replica change fails all 6 refresh-focus runs. Log refinements (window
  capture listeners, correct parent for Element#remove, deduped sync notes).
- Inbox entry `docs/bugs-inbox/webkit-focus.md` "B-42 (existing)" (committed with this file).

Decisions: no fix (task step 4 — nothing reproduced, nothing to fix without guessing). Headed
WebKit not run (would take the keyboard from the owner's live session). No BlockTree hunks at all,
so no merge surface with m11/remote-rewrite.

- Broad e2e on `94ed831`'s code (13 specs: popups, focus, focus-return, editing,
  editing-row-leaves, autocomplete, autocomplete-busy-replica, follow-link-popup,
  journal-stream-editing, diagnostics, storage, webkit-refresh-focus, focus-log):
  - chromium: 106 passed, 1 skipped (storage's webkit-only test).
  - webkit (temporary config without testMatch, deleted): 101 passed, 6 failed. All 6 also fail
    with the app files reverted to `52e5d20`. Five fail at the first assertion after a reload or
    `goto` (in-memory replica loses its unpushed queue — expected, B-43); one is new B-501
    (Alt+Up/Down caret to 0 in WebKit), logged in the inbox, not diagnosed.

## 2. In flight

(nothing)

## 3. Next steps

1. Owner: record a focus log in the desktop app (Diagnostics → Focus log) covering one loss.
2. B-501: check Alt+Up/Down in the desktop app; diagnose if it reproduces there.
