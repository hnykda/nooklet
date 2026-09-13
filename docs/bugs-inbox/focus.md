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

---

### B-231 (existing)

**Fixed 2026-09-13.** Reproduced first (the entry had it inferred only): right-click a block being
edited, press on the first `.ctx-sep` — `activeElement is body`, the menu still open. One
correction to the entry: the row KEEPS the editor (the snapshot at the failure still shows the
"Block content" textbox) — editing does not end, but nothing can type into it until a click, which
from the keyboard is the same thing. Fix as the entry proposed: `onMouseDown` `preventDefault` on
the `.ctx-menu` container in `app/BlockContextMenu.tsx`, so no press anywhere in the menu moves
focus (the items' own guard from B-71 and the timestamps footer's from B-230 stay; they are now
redundant but harmless). Test that would have caught it: `e2e/tests/focus-return.spec.ts`
"pressing on a context-menu separator or on the menu's padding keeps the block in edit mode"
(a separator, then the menu's padding at (2, 2), focus read after each, Escape, `End` + `!` in the
stored block); failed before the change, passes after. context-menu + block-timestamps +
focus-return + selection: 41 passed, 1 skipped.

---

### B-291 · Text composed in place (an IME's marked text, a dead-key accent) while the date picker is open goes into the block behind it
**Status:** open (needs the owner's call) · **Severity:** low · **Found:** 2026-09-13, m9/focus
(split out of B-147) · **Test:** none; probe `tools/probes/date-picker-composition.spec.ts`

B-147's second half, the part its fix could not reach. With the picker open over a block being
edited, a composition — emulated through CDP `Input.imeSetComposition` ("ˇ", then "č") and committed
with `Input.insertText` — is written into the block: editor `"compose ˇ"`, then `"compose č"`, and
the picker's query stays empty. Plain `insertText` right after it (what the B-147 fix takes) reached
the picker (`"zítra"`), so the probe tells the two apart. A composition's `beforeinput`
(`insertCompositionText`) cannot be cancelled, and CodeMirror applies the DOM change itself, so no
listener can keep it out while the editor holds DOM focus.

Unverified on real hardware: which layouts compose. By the B-147 entry's reading, a Czech Mac
layout's number-row letters are ordinary keydowns (fine), while háček/čárka dead keys and every CJK
IME compose (this bug). The picker's vocabulary is English words and digits, so what lands is junk
in the block, not a wrong date.

Why it is not fixed here: the only robust fix is for the picker to OWN focus while open — a
visually hidden input inside it takes every kind of text input natively — and hand focus back on
close (`commands/focus-return.ts#rememberFocus` now does that part). That reverses a deliberate
design choice in `DatePicker.tsx` ("the editor KEEPS focus… the caret is exactly where it was by
never having left"), changes what `e2e/tests/dates.spec.ts` asserts ("while the picker is open" the
editor is focused), and on a phone a focus move between inputs affects the virtual keyboard in ways
nobody here can test. Owner decision: keep "editor keeps focus" and accept this, or move focus
into the picker.

---

### B-147 (existing)

**Fixed 2026-09-13** — both holes the entry names, except composition, now B-291. Reproduced first:
the four e2e tests below failed on `cf08d19` (keys typed in the gap went to the block and the
picker's query stayed empty; Escape in the gap dropped the block into selection mode and the
picker opened anyway; `insertText("zítra")` went into the block).

1. **Type-ahead.** `commands/date-picker/type-ahead.ts#holdPickerInput`: the host
   (`date-picker/host.ts#open`) starts a window capture hold the moment it is asked to open — before
   the replica read and the lazy import. The hold reads each key with the picker's own
   `pickerKeyAction` (shared, so an early key means what it would have meant later), swallows and
   keeps the picker's keys and keydown-less text, cancels on Escape (swallowed, and later keys are
   the block's again), on a Cmd/Ctrl shortcut (left to do its job) and on a press anywhere.
   `openDatePicker` does not open for a cancelled hold, and otherwise replays the held input right
   after `render` returns — one synchronous stretch, so nothing can be typed between the replay and
   the picker's own listener — then releases it. Keys held after one that closed the picker (a
   replayed Enter) are dropped; they were already swallowed and cannot go back to the block.
2. **No keydown.** The open picker and the hold both take `beforeinput` `insertText`.

Tests that would have caught it: `e2e/tests/date-picker-type-ahead.spec.ts` "keys typed before the
picker is listening go to the picker, not the block", "a whole date and Enter typed before the
picker is listening sets the date once it is", "Escape typed before the picker is listening cancels
it: nothing opens, nothing is stored", "text that arrives without a keydown goes to the open picker,
not the block" — the gap is made deterministic by delaying the picker's chunk 800 ms with
`page.route` (service workers blocked so the request is routable), not by typing fast. Unit:
`commands/date-picker/type-ahead.test.ts` (10), `host.test.ts` "createDatePickerHost.open holds
type-ahead (B-147)" (2). With `dates.spec.ts`: 11 of 11 passed at load average 82.

---

### B-203 (existing)

**Diagnosis 2026-09-13 (m9/focus): a real bug, not a test-harness artifact.** Probe
`tools/probes/alt-enter-follow-link.spec.ts`, Chromium on macOS, port 6401, five cases:

- A — the entry's exact steps (`alpha [[…]] omega`, Home, ArrowRight ×9, `Alt+Enter`): nothing.
  The window saw `keydown key=Enter code=Enter altKey=true`, and it bubbled back up with
  `defaultPrevented=false` — no handler took it. A `.cmd-popup` was open before the key.
- B — caret at the end of a trailing `[[link]]`: followed. No popup open.
- C — A's caret, the key sent as a raw CDP `Input.dispatchKeyEvent` (`modifiers: 1`), the way a
  real keyboard's event reaches the renderer: nothing — so not Playwright's Alt handling.
- D — the caret further inside the link: nothing, popup open.
- E — A's caret, the popup dismissed with Escape first, then `Alt+Enter`: followed.

Cause: walking the caret into an existing link re-detects the `[[` trigger before the caret
(`CommandLayer`'s keyup re-detection) and opens the page autocomplete, which claims the popup keys.
The global keymap (`commands/keymap/dispatch.ts`, R12 step 2) then yielded every `Enter` to the
popup, modifiers or not — but the editor, which is what hands that popup its keys, only offers it
keys without Cmd/Ctrl/Alt (`BlockTree.tsx#dispatchKey`). So `Alt+Enter` belonged to nobody. The
same holds for anything else bound to a modified Enter/Tab/arrow while the autocomplete or slash
menu is open (Cmd/Ctrl+Enter `task.cycle`, Alt+Up/Down `block.moveUp/Down`). A real keyboard
takes the same path; only "put the caret in a link without opening the popup" (End after a
trailing link, as in `follow-link.spec.ts`) avoided it.

**Fixed 2026-09-13.** The yield now asks whether the popup would actually receive the key:
`commands/popup-keys.ts` — a claim can say it is `editorFed` (AutocompletePopup, SlashMenu), and
`popupTakesKey(event)` is "a popup key, and either the popup has its own input or the key has no
Cmd/Ctrl/Alt". `keymap/dispatch.ts` step 2 consults it (injectable `popupTakesKey`, default the old
rule), `provider/CommandProvider.tsx` passes the real one, and spec R12 step 2 says so. Every other
claimant (palette, page picker, page actions, help menu, template picker, context menu, date picker)
keeps the old rule, so a modified key typed into the palette's input still never runs against the
block behind it.
Consequence worth knowing: with the autocomplete or slash menu open, Cmd/Ctrl+Enter (`task.cycle`)
and Alt+Up/Down (`block.moveUp/Down`) now run their commands instead of doing nothing, the same as
with no popup. Tests that would have caught it: `e2e/tests/follow-link-popup.spec.ts` "Alt+Enter
follows a [[link]] the caret was walked into, though that opened the autocomplete" (failed on
`cf08d19`: the URL stayed on the page) and, for the boundary, "with the autocomplete open, plain
Enter is still the popup's: it picks a row, it does not split the block"; unit
`commands/popup-keys.test.ts` (4) and `keymap/dispatch.test.ts` "step 2 asks popupTakesKey: a key
the popup never receives is dispatched (B-203)". Not fixed, and not asked: whether walking the caret
into an existing link should open the autocomplete at all.

---

### B-292 · `editing.spec.ts` "typing immediately after Enter is not discarded" cannot run with `--repeat-each`
**Status:** open · **Severity:** low (test harness) · **Found:** 2026-09-13, m9/focus (re-running
it to rule out load) · **Test:** the spec itself

It appends `- alpha` to a fixed page "Enter Probe" and then expects exactly one row, so on one server
the second run sees 2 rows, the third 3 (`Expected: 1, Received: 2…5`, `--repeat-each=5`). Passes
once per server, which is all a normal run does; it just cannot be looped to separate load from a
regression, which is the first thing a flaky-looking failure calls for. Fix: a page name per
`repeatEachIndex`/`retry`, as `views.spec.ts`'s palette test now has. Not changed here (not this
branch's spec).

---

### B-293 · Choosing a page in the palette while editing: keys typed before the new page shows go into the block being left
**Status:** open · **Severity:** medium (text lands on a page nobody is looking at) · **Found:**
2026-09-13, adversarial verification of m9/focus · **Test:** to come

A regression from B-161's fix on this branch. The palette now gives focus back to whatever had it as
it closes — including when the row chosen was a page (`selectRow` → `props.onSelectPage`) or
"Create page …" (`props.onCreatePage`). Both leave the page, but not at once:
`hosts.ts#createNavigationHost.openPage` resolves the page name with a replica read before it
navigates, and creating a page is a write first. In that gap the editor on the page being left is
focused again, so what is typed goes into its block — and is saved there, on a page that is no
longer on screen.

Probe (`e2e/tests/zz-verify-focus.spec.ts` in the verifier's run, port 6401): edit `- origin`,
Cmd+K, type another page's name, Enter, type `qq` at once. On `2924c05`: `activeElement` right after
Enter is `.cm-content`, and the stored block on the page left is `originqq` (1 of 1); same with the
Create page row (1 of 1). With `apps/web/src` checked out at `cf08d19`: focus on `<body>` and the
block stays `origin` (both). "Open journals" run from the palette does not show it (that navigation
is synchronous, so the editor is already detached when the palette closes).
