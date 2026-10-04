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

## Next

1. Commit; merge main (B-705).
2. B-705 global 16px rule, viewport meta check, e2e guard, Simulator proof.
3. Server-URL inputs: autocapitalize/autocorrect/spellcheck/inputmode; bare-address 401 message.
4. Simulator: B-662, B-664, B-684 event sequence, B-661 marker/toolbar tap keeps keyboard,
   B-699 via `simctl openurl`.
5. Full verification list.

## BUGS.md updates to fold in

(filled in at the end)
