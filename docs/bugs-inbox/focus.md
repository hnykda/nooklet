# Bug inbox — m9/focus

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-290..B-299.

---

### B-290 · Clicking into a block and pressing Cmd/Ctrl+K before the next frame: the editor takes focus back from the open palette
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9/focus (diagnosing B-161) ·
**Test:** `e2e/tests/focus-return.spec.ts` "a click into a block then Cmd/Ctrl+K before the next
frame: what is typed goes to the palette"; probe `tools/probes/palette-escape-focus.spec.ts` "a
late frame after entering editing vs an open palette"

The mirror image of B-161, from the same line of code. `editor/surface.ts#attach` re-asserts focus
twice after entering edit mode — a microtask and a `requestAnimationFrame` backstop — and the frame
one takes focus back from ANYTHING (`!view.hasFocus`), not only from the `<body>` a removed element
leaves behind. On a loaded machine a frame can arrive long after the input events that followed
it: a click into a block, Cmd+K, and the palette's input takes focus; then the late frame focuses
the editor underneath the open palette, and what is typed goes into the block, not the palette.

Probe, frames delayed 150 ms with an init script (what a starved renderer does to begin-frames
while input keeps being dispatched): click a block, Cmd+K, wait, type `zz` → `activeElement` is
`.cm-content` and the palette query is `""`, 3 of 3. Control with no delay: the input keeps focus
and the query is `"zz"`, 3 of 3. Not seen by a person yet; a fast Cmd+K right after a click on a
busy machine is the shape it would take.

**Fixed 2026-09-13.** The frame-later backstop in `surface.attach` now takes focus only from
`<body>` or from the element that still had focus when the attach ran (where entering edit mode
leaves it); focus that moved anywhere new in between was someone's decision and stays. The
microtask refocus is unchanged. Test that would have caught it: `e2e/tests/focus-return.spec.ts` "a
click into a block then Cmd/Ctrl+K before the next frame: what is typed goes to the palette" —
frames delayed 400 ms by `e2e/helpers/focus.ts#delayAnimationFrames`; it failed on `cf08d19`'s
`surface.ts` (`activeElement` was `.cm-content` under the open palette) and passes with the fix
(10 of 10 under load, see B-161).

---

### B-161 (existing)

**Diagnosis 2026-09-13 (m9/focus).** Not load-dependent at its core: nothing in the app gave focus
back when the palette closed. The palette's input takes focus in a microtask on open; Escape (or
Cmd+K, a backdrop click, a chosen row) unmounts it and focus falls to `<body>`, where it stayed.
Measured with `tools/probes/palette-escape-focus.spec.ts` on port 6401, production build:

- The test's own steps, machine at load ≈4 on 14 cores: `.cm-content` focused 0 of 6 runs; the
  real `views.spec.ts` test alone: failed 1 of 1; the whole of `views.spec.ts` (a traced copy):
  failed, 28 others passed.
- Under ten busy `node -e 'for(;;){}'` loops (load ≈8): 0 of 8. Under CDP CPU throttling ×20: 0
  of 6.
- With animation frames delayed 150 ms (init script): **4 of 4 passed** — and the `focusin` trace
  shows why: 100 ms after Escape the editor is focused from inside a frame callback, the
  `requestAnimationFrame` backstop `surface.attach` armed when the test's click entered editing.

So the test passed only when the click's frame-later refocus landed AFTER Escape: on a machine
starved enough that frames lag the keyboard (the dozen-agent runs at load 17-35), sometimes; on a
quieter one, never. That is why five workstreams saw "fails alone, passes in the full run" and the
coordinator saw the opposite — both were timing, and the test's auto-retrying `toBeFocused()`
(10 s) gave a stale backstop all the time it needed to rescue it. The same backstop's other
direction is B-290.

**Fixed 2026-09-13.** `apps/web/src/commands/focus-return.ts#rememberFocus`: the palette records
what had focus as it opens (an effect on `isOpen`, which runs before the input's focus microtask)
and gives it back as it closes, synchronously, in the same task as the key or click that closed it
— however it closes (Escape, Cmd+K again, a row, a command that closes it). It gives focus back
only when the palette is what lost it (focus on `<body>` or still inside the overlay) and only to
an element still in the document, so a command that moved focus on purpose, ended editing or
navigated away keeps its result. Outliner focus in block selection comes back the same way. The
test is now deterministic: `e2e/tests/views.spec.ts` "opening the palette while editing and
closing it hands focus back to the editor" reads `activeElement` once, straight after Escape
(`expectEditorFocusedNow`), instead of `toBeFocused()` retrying for 10 s, asserts the palette input
really had focus first, uses a page per repeat/retry (`--repeat-each` used to fail on the typed
text), and checks the stored block. Tests that would have caught it:
that test, and `e2e/tests/focus-return.spec.ts` "Escape out of the palette gives the editor focus
back in the same keystroke, even with frames arriving late", "Cmd/Ctrl+K pressed again to close the
palette also gives the editor focus back", "the palette opened from block selection gives the
outliner its keys back"; unit `apps/web/src/commands/focus-return.test.ts`.

Proof, port 6401: with `CommandPalette.tsx` and `surface.ts` restored to `cf08d19`, all five of
those e2e tests failed (`activeElement is body`). Loop under 20 busy node processes (load average
12 → 41): the ORIGINAL test (only its page name made unique) 0 of 10, the new form 0 of 10. With
the fix, same load (36 → 64), `--repeat-each=10` over the original test, the four palette tests in
`views.spec.ts` and the four in `focus-return.spec.ts`: 90 of 90 passed. Duplicates closed by this:
B-173, B-182, B-193, B-213, B-226, B-246, B-270.

---

### B-195 (existing)

**Fixed 2026-09-13.** Reproduced first as an e2e test (failed on `cf08d19`: `activeElement is body`
straight after the picker closed). Same cause as B-161: the "Move to page…" picker
(`app/refactor-host.tsx#pickPage`) puts focus in its input and nothing gave it back. It now records
what had focus before it mounts (`commands/focus-return.ts#rememberFocus`) and gives it back as it
closes, after its root leaves the document and before the command's server op — so when the pull
moves the row to the end of the page, the editor is focused again and `BlockTree`'s
`refocusAfterReorder` keeps it through the DOM move. Run from the palette, the palette gives focus
back to the editor as `closePalette` runs, so the picker records the editor, not `<body>`. Tests that
would have caught it: `e2e/tests/focus-return.spec.ts` "Move to page… onto the block's own page
while editing it leaves the editor focused and typeable" (right-click, pick its own page, focus
read straight after Enter and again after the row moved, `End` + `!` lands in the stored block) and
"Move to page… run from the palette hands focus through the palette and the picker back to the
editor" (Escape out of the picker); both failed with `refactor-host.tsx` at `cf08d19`.
