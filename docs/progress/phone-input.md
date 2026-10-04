# phone-input — B-662, B-664, B-661, B-699, B-684 follow-up, B-705 (+ URL fields, token error)

Branch: the agent's own worktree branch (based on `6d56c8f`). Not merged, not pushed.

## Status

In flight. Code fixes for B-662, B-664, B-661, B-699 done and green in e2e (Chromium + WebKit);
Simulator proof for B-662/B-664/B-684 not yet run. Then B-705 and the coordinator's two URL-field
additions.

## Done

- B-699: `ConnectView` — the editable "Server address" field is not shown for a pairing link
  (token or code); its address shows once, read-only (`pairing-server`). Unit:
  `PairingLinkPrompt.test.tsx` (token link and code link).
- B-662: `VirtualJournalDay` — the draft also handles `beforeinput` `insertLineBreak` /
  `insertParagraph` (cancels it, runs `onEnter`), with a flag so a keydown that already ran
  `onEnter` is not counted twice, and Shift+Enter's soft line break is left alone.
- B-664: `app/hosts.ts#hideKeyboard` — `requestEditingEnd()` then blur. Before, a blur alone left
  the block in edit mode (`editorFocused` true), so the toolbar stayed. The toolbar unmounts on
  session end, so it comes back scrolled to its start.
- B-661: `editor/keep-focus.ts#keepEditorFocus` — cancel `mousedown` always, `pointerdown` only for
  a non-touch pointer. Used by the task marker, bullet, collapse arrow and the R61 toolbar. Red
  before the fix in Chromium touch emulation for the marker, the toolbar (hide-keyboard and indent)
  and the collapse arrow.
- e2e `e2e/tests/phone-input.spec.ts` (iPhone 13, `tap()`), added to the webkit project:
  14/14 (7 × Chromium + WebKit) on port 6520.

- Coordinator additions (commits `8a835048` and the one before it):
  - B-705: `shell.css` one `(pointer: coarse)` rule, `max(16px, var(--field-font-size, 1em))
    !important` for input/textarea/select; per-field B-648 overrides removed; page title keeps
    26px via `--field-font-size`. iOS app only: `maximum-scale=1` (`platform/viewport-meta.ts`).
    e2e `phone-fields.spec.ts` (all forms; red with the rule's `!important` removed: the draft at
    15px). CodeMirror's contenteditable deliberately not included (pending Simulator check).
  - Server-URL fields: web ones already had inputmode=url, autocapitalize=none (same as "off"),
    autocorrect off, spellcheck false; the desktop launcher's two had none — added.
  - Bare address + refused token: `connect-graph.ts#rejectedTokenMessage`.
  - B-706: `data/token-input.ts` (normalise + shape check, `vrt_` legacy prefix accepted —
    tokens.ts says pre-rename tokens still work). ConnectView (incl. repair) and GraphSwitcher
    (connect: device; "Show graphs" and promote: root).
- Simulator probe `tools/probes/phone-input/` (run.sh, overlay.js, XCUITest). Private device
  `phone-input-probe-afd1` UDID 25877DD0-F61B-4DDB-8E3D-627B0F0423BD (delete when done). Scratch
  server port 6521, data in the scratchpad (graphs default + second).

## Next

1. Simulator runs: A (enter, blockenter, blockslash, marker, toolbar, hide); delete today's page;
   B (draftslash); C (switcher with second graph + `.`-suffixed token, small); D (B-699 openurl).
2. Full verification list; fold-in section; delete the device; `pnpm ios:sync`.

## BUGS.md updates to fold in

(filled in at the end)
