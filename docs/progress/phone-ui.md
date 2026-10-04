# phone-ui — B-646, B-648, B-649, B-650, B-651 (owner's iPhone test, 2026-10-04)

Branch: the agent worktree branch (not merged). Status: **fixes committed; full e2e run pending**
— see "Next".

## Done

- Probe: `tools/probes/phone-ui/` — XCUITest bundle + `run.sh` + `event-overlay.js` (an on-screen
  key/input event log, since a headless WKWebView has no console). Private Simulator
  `phone-ui-probe-a1ec` (iPhone 17, iOS 26.5), UDID 9AF07D62-B61B-41BC-B16D-6C908FD61210 — delete
  when done.

## Findings (evidence)

- **B-646.** Simulator, soft keyboard (run 2, screenshot `2-after-enter`): typing `/` in today's
  draft delivers `keydown "/" (191)`, `beforeinput insertText "/"`, `input`, `keyup "/"` — normal
  key events. The menu did not open because the draft is a plain `<textarea>`, not the block
  editor, and the slash trigger only reads the block editor (`CommandLayer` keyup →
  `editor.getSelection()` is null in the draft). On a phone an empty day's draft is the first
  thing you type into. Second cause: the toolbar's `/` (`block.openSlashMenu`) had
  `when: editorFocused && atLineStart`, and `atLineStart` is caret at offset 0 of the block, so it
  was greyed out everywhere else.
- **B-648.** Simulator (run 1, `6-props-field-focused`): tapping the "property" field made
  `visualViewport.scale` 1.23 and `innerWidth` 326 — iOS's zoom-on-focus for a field under 16px
  (`.page-property-*` set `font-size: var(--text-sm)` = 13px, overriding the global 16px). iOS
  never zooms back, hence "until restart". Also the add row's two inputs have an intrinsic
  `size=20` min width, flex `min-width:auto`, so the row could exceed 390px.
- **B-649.** Nothing tracked whether history had entries either side.
- **B-650.** `GraphSwitcher` closed on Escape and its own button only.
- **B-651.** Logseq mobile: the mobile bar's checkbox button runs `editor-handler/cycle-todo!`
  (`src/main/frontend/mobile/mobile_bar.cljs` @ 0.10.9:
  `(command #(do (blur-if-compositing) (editor-handler/cycle-todo!)) {:icon "checkbox"} true)`),
  i.e. the same cycle as Mod+Enter. Ours ran `task.toggleDone`, which never reaches DOING/NOW and
  was disabled on a non-task block.
- **Found in passing (not fixed, logged below):** (1) Playwright Chromium with touch (`tap()`):
  the task marker's `onPointerDown preventDefault` swallows the `click`
  (`tools/probes/phone-ui/marker-tap-chromium.spec.ts`), so on Chromium-on-Android a tap on the
  checkbox (and likely the R61 toolbar buttons, same pattern) would do nothing. On iOS it works
  (Simulator run 4, `6-checkbox-tapped.png`). (2) Simulator, soft keyboard: Return in today's draft
  textarea inserted a newline (`keydown Enter` → `beforeinput insertLineBreak` → draft `"ab\n"`),
  so the line was not committed as a block; the draft's keydown `preventDefault` does not stop
  iOS's line break. CodeMirror has its own iOS Enter workaround (the log shows its re-dispatched
  second `keydown Enter`), the plain textarea has none. (3) `e2e/tests/tasks.spec.ts` "Cmd/Ctrl+Enter
  cycles…" and "clicking the rendered marker…" fail on a fresh server: they expect TODO, and since
  `34c8d3e` an empty graph starts at LATER. Fails with or without this branch's changes (the
  assertion that fails is the class after the first Mod+Enter). (4) After the toolbar's "hide
  keyboard", the toolbar stays on screen at the bottom, scrolled sideways (`6-checkbox-tapped.png`).

## Fixes

1. B-646: `VirtualJournalDay` — a `/` that would open the menu starts the day at once, caret where
   it was (`requestBlockFocus(id, {offset})`); `CommandLayer` also re-detects triggers on `focusin`
   and `input` (deferred a macrotask), so the menu opens once the block editor has the caret, and
   text with no keyup (suggestion bar, dictation, IME) is seen. `block.openSlashMenu` →
   `when: editorFocused`, inserting ` /` mid-word (`insert-logic.ts#insertSlash`). Spec R50 updated.
2. B-648: `views.css` — `min-width: 0` on the property inputs; 16px under `(pointer: coarse)` for
   them and for the search/task filter inputs (same 13px override).
3. B-649: `shell/history-position.ts` — Navigation API `canGoBack/canGoForward`, else the router's
   `_depth` vs `history.length`; re-read a macrotask after each location change. Buttons
   `disabled`; hover no longer lights a disabled icon button.
4. B-650: `GraphSwitcher` — outside `pointerdown` closes it (same as `MoreMenu`).
5. B-651: toolbar button 9 → `task.cycle` (lucide SquareCheck icon), spec R60 table updated;
   markers drawn with lucide squares (`editor/TaskMarkerIcon.tsx`: Square / SquareDot /
   SquarePause / SquareCheck / SquareX) in the outliner, shelf, agenda, query results, read-only
   outlines and the Tasks view; the outliner marker is `role="checkbox"` with `aria-checked`
   (`mixed` for DOING/NOW); bigger tap target under a coarse pointer.

## Tests

- e2e `e2e/tests/phone-ui.spec.ts` (iPhone 13 descriptor; chromium + webkit projects).
- unit: `insert-logic.test.ts` "insertSlash (R50, B-646)", `shell/history-position.test.ts`.
- updated: `tasks.spec.ts`, `navigation.spec.ts` (glyph text → icon + aria-checked),
  `MobileToolbar.test.tsx`.

## Simulator (iPhone 17, iOS 26.5, real app, soft keyboard), fixed build — run 4

Screenshots kept in `tools/probes/phone-ui/` (overlay at the top: header line is
`popup / documentElement.scrollWidth / innerWidth / visualViewport width@scale`):

- `1-draft-slash.png` — `ab /` typed into today's empty draft: the slash menu is open, the log shows
  `focusin cm-content` right after the `/` and `popup=true cm="ab /"`; keyboard stayed up.
- `3-after-todo.png` — `todo` + Return picked TODO from the menu: the row shows the new empty
  checkbox (lucide square) before `ab`.
- `4-cycled.png` — toolbar task button (rightmost visible, checkbox icon): the marker is now the
  in-progress square-with-dot, orange (NOW under the empty graph's `now` workflow).
- `6-checkbox-tapped.png` — a real tap on the checkbox: DONE (green ticked square), text struck.
- `8-props-field-focused.png` — Properties open, "property" field focused with the keyboard up:
  `vv=402@1.00` (no zoom), `docW=402 innerW=402`, key/value/Add all within the screen. Before the
  fix the same step gave `vv=326@1.23` (run 1). Back is enabled, Forward greyed (B-649).

## Next

- Full e2e run (both projects) and record the result here.
- Delete the Simulator device when done (`xcrun simctl delete 9AF07D62-…`).

## BUGS.md updates to fold in

- **B-646** → fixed (commit below). Cause: two. (a) The slash menu only reads the block editor, and
  an empty day's first line is a plain `<textarea>` (`VirtualJournalDay`) — on the phone that is
  the first thing you type into; the iOS soft keyboard itself delivers normal `keydown`/`keyup "/"`
  (Simulator log). (b) The toolbar's `/` needed `atLineStart` (caret at offset 0), so it was greyed
  out anywhere else. Fix: a triggering `/` in the draft starts the day with the caret after it;
  `CommandLayer` re-detects on `focusin` and `input` too; toolbar `/` works anywhere (adds a space
  mid-word). **Test:** `e2e/tests/phone-ui.spec.ts` "B-646: …empty day's first line…", "…`input`
  only…", "…toolbar's `/` works mid-block…" (Chromium + WebKit); `insert-logic.test.ts`
  "insertSlash (R50, B-646)"; Simulator `tools/probes/phone-ui/1-draft-slash.png`.
- **B-648** → fixed. Cause: the property fields' 13px text (overriding the global 16px) made iOS
  zoom the page in on focus (Simulator: `visualViewport.scale` 1.23) and iOS never zooms back;
  plus the inputs' intrinsic width could push the add row past 390px. Fix: 16px under
  `(pointer: coarse)` (also the search and task filter inputs, same override), `min-width: 0`.
  **Test:** `phone-ui.spec.ts` "B-648: …within the screen, fields at 16px"; Simulator
  `8-props-field-focused.png` (scale 1.00). The B-572 viewport meta needed no change.
- **B-649** → fixed. Back/Forward `disabled` from the Navigation API (`canGoBack/canGoForward`),
  else the router's `_depth` vs `history.length` (`shell/history-position.ts`). **Test:**
  `phone-ui.spec.ts` "B-649…" (Chromium + WebKit), `history-position.test.ts`.
- **B-650** → fixed. Outside `pointerdown` closes the switcher, as the "⋯" menu does. **Test:**
  `phone-ui.spec.ts` "B-650…".
- **B-651** → fixed. (a) Toolbar button 9 is now `task.cycle` (Mod+Enter's command; was
  `task.toggleDone`, which never reaches DOING/NOW and was disabled on a non-task block) — Logseq
  mobile's bar does exactly this: `(editor-handler/cycle-todo!)` with the "checkbox" icon,
  `src/main/frontend/mobile/mobile_bar.cljs` @ 0.10.9. Respects B-608 (LATER→NOW→DONE under `now`).
  (b) Markers drawn as lucide icons (square / square-dot / square-pause / square-check / square-x)
  everywhere a task is drawn; the outliner marker is `role="checkbox"` + `aria-checked`
  (`mixed` = DOING/NOW). **Test:** `phone-ui.spec.ts` "B-651: the toolbar's task button cycles…",
  "B-651: the task checkbox is an icon…"; `navigation.spec.ts` "each task state renders its own
  icon"; Simulator `4-cycled.png`, `6-checkbox-tapped.png`. Spec R60 table updated.
- **New (open):** a TAP on the task marker does nothing in Chromium touch emulation — its
  `onPointerDown preventDefault` swallows the click (probe
  `tools/probes/phone-ui/marker-tap-chromium.spec.ts`). iOS is fine (Simulator). Would affect
  Chromium on Android, and probably the R61 toolbar buttons, which use the same pattern. Severity
  low while the phone app is iOS-only.
- **New (open):** iOS soft keyboard: Return in an empty day's draft textarea inserts a newline
  instead of committing the line as a block (Simulator event log: `keydown Enter` then
  `beforeinput insertLineBreak`, draft `"ab\n"`). The keydown `preventDefault` does not stop it on
  iOS. Severity medium (a fresh day on the phone). Unverified on a physical iPhone.
- **New (open):** `e2e/tests/tasks.spec.ts` two tests expect TODO after the first Mod+Enter on a
  fresh server; since `34c8d3e` (empty graph → `now`) it is LATER. Test lagging the decision.
- **New (open, low):** after the toolbar's hide-keyboard button the toolbar stays at the bottom of
  the screen, scrolled sideways.
