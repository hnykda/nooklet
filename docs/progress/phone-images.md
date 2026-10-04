# phone-images — B-681..B-684 + phone overflow sweep (2026-10-04)

Branch: the agent's own branch (based on `988c78f`, fast-forwarded to `c536cad` for B-684). Not
merged, not pushed.

## Status

**Done.** `35757ee` (fixes + tests), `45c1a91` (probe screenshots/helpers), then this file.
Nothing in flight. Coordinator: fold the section at the bottom into BUGS.md.

## Verification (2026-10-04, on `45c1a91`)

- `pnpm e2e` (port 6482, both projects): **789 passed, 2 skipped, 0 failed** (23.5 min).
  `phone-images.spec.ts` 12/12 (6 tests × Chromium + WebKit).
- `pnpm --filter @nooklet/web test`: 184 files, 1627 tests passed. `pnpm -r typecheck` clean.
  `pnpm exec biome check . --diagnostic-level=error` clean. `node tools/leak-check.mjs --tree`
  clean.
- Simulator, fixed build (`tools/probes/phone-images/`): `2-after-slash.png` — `/` tapped on the
  soft keyboard's 123 layer; log shows `input insertText` at 17620 ms and `popup -> P` at
  17624 ms, before `keyup`; menu directly under the caret, above the keyboard.
  `7-photo-rendered.png` — a 4032×3024 library photo inserted via `/image`: `img=342x257`
  (4:3), `docW=402 innerW=402 vv=402@1.00`. `0-seeded-image-before-fix.png` — the base build,
  same numbers for a seeded 1200×900 PNG.
- Simulator device deleted, scratch server stopped, `pnpm ios:sync` re-run (no overlay in the
  built bundle).

## Reproduction on current code, real Capacitor app (before any fix)

Private Simulator `phone-images-probe-a0a7` (iPhone 17, iOS 26.5), the real app built from this
branch's base, connected to a scratch server on port 6481 (today's journal: "first block", an
uploaded 1200×900 PNG, "third block"). Probe: `tools/probes/phone-images/` (`run.sh`, an XCUITest
that drives the SOFTWARE keyboard and the system photo picker, and `overlay.js`, an on-screen
event log + layout numbers).

- **B-681 (slash menu away from the caret): already fixed on current main** — confirmed by the
  owner on the iPhone after rebuilding, and on the Simulator (menu directly under the caret line).
  A remaining problem found in e2e: the popup was placed at the caret's bottom-left with no
  clamping, so with the caret past mid-line at 390px its right edge left the screen
  (`popup.right` > 390), and a caret low on the screen put it under the keyboard. Fixed (below).
- **B-684 (menu only after the next character): NOT reproduced on the Simulator.** Real key taps
  (123 layer, then `/`) in a block editor: `keydown "/" 191` → `beforeinput insertText "/"` →
  `input insertText` (CM text already `first block /`) → popup present 5 ms later, before
  `keyup`. XCUITest `typeText` gives the same. So on the Simulator the `/` is in CodeMirror's
  state by the time `input` fires and the deferred re-detection sees it. The mechanism that CAN
  produce the owner's symptom: CodeMirror reads a DOM change after the last event has fired —
  `DOMObserver` defers with `flushSoon` (a frame) when iOS is composing (`@codemirror/view`
  6.43.11 `index.js` ~7138: "iOS Safari will, when ending a composition, sometimes first clear
  it…"), and the physical keyboard's predictive/autocorrect paths are not what the Simulator's
  keyboard does. Every trigger re-detection ran only on events (keyup, pointerup, focusin,
  input), so a change landing after them was not looked at until the next key. Fixed at that
  cause (below). **Unverified on a physical iPhone.**
- **B-682 (letterboxed image): NOT reproduced.** Seeded 1200×900 PNG: `img=342x257
  nat=1200x900` (4:3, box = picture). A real library photo picked through `/image` → Photo
  Library → the system picker: stored as a 4032×3024 JPEG with EXIF Orientation 3, rendered
  `342x257`, upright, no bars (`run2/7-rendered`). A 1600×1200 JPEG with EXIF Orientation 6 (an
  iPhone portrait photo's shape, `orient.mjs`): rendered rotated, portrait, no bars.
- **B-683 (image widens the page): NOT reproduced.** After inserting the picked photo:
  `docW=402 innerW=402 vv=402@1.00` (iPhone 17 is 402pt wide) in both the editing and rendered
  states.

## Done

- B-684: `surface.ts` reports every CodeMirror update with `docChanged || selectionSet`
  (`SurfaceDeps.onEditorChange`); `app/editor-host.ts#notifyEditorChange/onEditorChange`;
  `CommandLayer` re-detects on it (deferred a macrotask like its other re-detections). Desktop
  unchanged: detection is idempotent, so keyup + update cannot open twice.
- B-681 follow-up: `commands/popup-position.ts` — `placeAtCaret` (below the caret line if it fits
  above the keyboard toolbar / visual viewport bottom, else above the caret line, else the roomier
  side shortened; shifted left to stay on screen) + `createCaretPopupStyle` (measured size). Used
  by `SlashMenu` and `AutocompletePopup` (`[[`, `#`, `((`). `CommandLayer` now passes the caret's
  top AND bottom.
- B-682 hardening: `.vr-image` `width/height: auto`, `max-height: 70vh` (a tall screenshot was
  several screens long; ratio kept).
- Sweep fix: `.katex-display` scrolls inside itself (`overflow-x: auto`) — a long display formula
  ran past the block edge at 390px (outermost offender `SPAN.katex-base right=886`).
- Tests: `e2e/tests/phone-images.spec.ts` (iPhone 13; chromium + webkit, added to the webkit
  `testMatch`), `e2e/helpers/png.ts` (solid PNG of any size), `commands/popup-position.test.ts`.
  The "no event after it" test fails without the fix in both engines (checked by disabling the
  subscription: popup never appears).

## Overflow sweep (390px, Chromium + WebKit, rendered AND while editing)

Long bare URL, labelled link, autolink, 160-char unbroken word, long `[[page]]` and `#tag`,
long inline code, code fence, wide table, display math, 2000px-wide image, quote with URL,
wide mermaid diagram, page embed holding a long URL: only display math overflowed (fixed). The
rest already wrap (`overflow-wrap: anywhere`) or scroll inside themselves (fence, table).

Found in passing (not fixed, logged below): tables written with leading pipes render every cell
as `|` (`tools/probes/phone-images/table-cells.spec.ts`).

## Next

Nothing. Owner re-check below.

## For the owner to re-check on the phone (after `pnpm ios:sync`, then ⌘R in Xcode)

- B-684: in an existing block, type a space then `/` — the menu should appear with the `/`, no
  further key. Try with your usual keyboard (Czech/English, predictive on).
- B-682: insert a photo with `/image` → Photo Library. It should show at its own shape, no black
  bands. If you still see bars, a screenshot plus "light or dark theme" and "where" (in the
  journal, a page, an embed, or the full-screen preview iOS shows on a long press) would pin it.
- B-683: after inserting, the page should not scroll sideways or look zoomed.

## BUGS.md updates to fold in

- **B-681** → already fixed (owner-confirmed); plus `fixed` follow-up: the popup is clamped to
  the screen and flips above the caret when the keyboard leaves no room (`popup-position.ts`).
  **Test:** `phone-images.spec.ts` "B-681: the slash menu opens at the caret and stays on the
  screen" (failed before: `popup.right` past 390), `popup-position.test.ts`.
- **B-684** → fixed (believed; not reproduced on the Simulator, where `/` already opened the menu
  at once). Cause addressed: trigger detection ran only on DOM events, and CodeMirror can take a
  typed character in after them (iOS composition: `DOMObserver.flushSoon`). Now also re-detected
  on every CodeMirror update that changes the text or the caret. **Test:**
  `phone-images.spec.ts` "B-684: a `/` that reaches the editor with no event after it still opens
  the menu" (red without the fix, Chromium + WebKit), "B-684: `/` alone opens…". Unverified on a
  physical iPhone.
- **B-682** → not reproduced on current code (Simulator, real photo picker, EXIF orientations 3
  and 6). Hardening: `.vr-image` max-height 70vh, auto width/height. **Test:**
  `phone-images.spec.ts` "B-682/B-683: an image picked with /image keeps its aspect ratio…",
  "B-682: a small image keeps its own size, a tall one is capped…". Owner to re-check.
- **B-683** → not reproduced on current code (Simulator: `docW=innerW=402`, scale 1.00 after
  inserting a photo). **Test:** as above, plus "phone overflow sweep…". Owner to re-check.
- **New (fixed):** a long `$$…$$` display formula widened the page at phone width; now scrolls
  inside itself. **Test:** "phone overflow sweep…".
- **New (open, medium):** a markdown table written with leading pipes (`| a | b |`, the usual
  form, and Logseq's) renders every cell as `|` (each cell `<span data-from="0" data-to="1">|`).
  The no-leading-pipe form (`a | b`) renders correctly. Unit test `tokens.test.tsx` "table -> …"
  checks structure only, with the no-pipe form. Probe
  `tools/probes/phone-images/table-cells.spec.ts`.
- **Note:** an image is `loading="lazy"` with no reserved size, so it is 0×0 until scrolled near
  and the rows below move when it loads. Reserving space needs the dimensions, which
  `asset.upload` does not record; not done.
