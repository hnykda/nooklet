# phone-input — B-662, B-664, B-661, B-699, B-684 follow-up; B-705, B-706, URL fields, token message

Branch: the agent's own worktree branch (based on `6d56c8f`, `main` merged in for B-705/B-706 and
the token-field change). Not merged, not pushed.

## Status

Done. Nothing in flight. Coordinator: fold the section at the bottom into BUGS.md.
Commits: `00eae60a` (B-662 beforeinput, B-664, B-661, B-699), `575bd56f` + `8a835048` (B-705,
B-706), the connect-message/launcher commit, `a8df8137` (B-662 real cause), then the probe +
this file.

## Findings (evidence)

- **B-662 — the cause was not what the bug said.** Simulator, real app, soft keyboard, overlay
  log with `shiftKey` and `defaultPrevented` (`tools/probes/phone-input/0-b662-before-shift-enter.png`):
  `keydown "Enter" 13 shift=true` → `keydown+0ms prev=false` → `beforeinput insertLineBreak` →
  draft `"ab\n"`. iOS reported `shiftKey=true` for every key typed there (lowercase letters too) —
  its auto-capitalisation shift. The draft's keydown read Return as Shift+Enter (its soft line
  break) and let it through, so the keydown `preventDefault` never ran at all; it was not "ignored
  by iOS". Same in a block: the command layer (document capture) maps Shift+Enter to
  `block.newline`, so Return put a line break in the block instead of splitting it (seen as
  `rows=["abcd"]` with a CodeMirror newline, run A4). CodeMirror has exactly this workaround
  internally (`@codemirror/view` 6.43.11, `InputState.keydown`: "On iOS with autocapitalize, drop
  the shift modifier for these keys, since it will be set at the start of every sentence"), but
  our command layer takes Enter before CodeMirror sees it. How often a person's thumb hits this on
  a physical iPhone (shift lit at a sentence start: empty line, after ". ") is **unverified**; on
  the Simulator, XCUITest typing left shift lit throughout.
- **B-664**: a blur ends nothing in `BlockTree` (only an outside click or `requestEditingEnd`), so
  after "hide keyboard" `editorFocused` stayed true and the toolbar stayed, still scrolled.
- **B-661**: `onPointerDown preventDefault` on a touch pointer makes Chromium send no `click`
  (marker, bullet, collapse arrow, toolbar buttons — red in Chromium touch emulation before the
  fix). Focus moves on `mousedown`, which is the event to cancel.
- **B-684**: not reproducible after the phone-images fix — the menu opens on the `/` itself.
  Event sequences (soft keyboard, 123-layer `/` key):
  - empty day's draft (`6-b684-draft-slash.png`): `18711 keydown "/" 191` → `18716 beforeinput
    insertText "/"` → `18716 input` (draft `"a /"`, day starts) → `18854` block editor holds
    `"a /"` → `18861 popup -> P` → `18868 keyup "/"` (on the block editor). Menu 150 ms after the
    key, before keyup.
  - block editor (`7-b684-block-slash.png`): `25202 keydown "/"` → `25206 beforeinput` → `25207
    input` (`"cdx /"`) → `25209 keyup` → `25212 popup -> P`. 10 ms.
- **B-705**: `.graph-switcher-field input` was 12px (`--text-xs`), beating the global
  `input { 16px }` by specificity. CodeMirror's content is 15px (`--text-md`) and is NOT covered by
  the new rule on purpose: with a block focused and the keyboard up the overlay reads
  `vv=402@1.00` in every run (e.g. `7-b684-block-slash.png`), i.e. iOS does not zoom on it, and
  16px there would make the line change size between reading and editing.
- **Viewport `maximum-scale=1`**: WebKit, "New Interaction Behaviors in iOS 10"
  (https://webkit.org/blog/7367/new-interaction-behaviors-in-ios-10/): Safari ignores
  `user-scalable`/`min-scale`/`max-scale` for pinch-zoom since iOS 10, but a `WKWebView` honours
  them unless `ignoresViewportScaleLimits` is set (default false). Capacitor's WKWebView has
  pinch-zoom off anyway (`@capacitor/ios` 8.5.1 `CAPInstanceDescriptor.m` `_zoomingEnabled = NO`;
  `WebViewDelegationHandler.scrollViewWillBeginZooming` disables the pinch recogniser). Chrome on
  Android honours `maximum-scale` (Rick Strahl, https://weblog.west-wind.com/posts/2023/Apr/17/Preventing-iOS-Textbox-Auto-Zooming-and-ViewPort-Sizing).
  So added in the Capacitor app only (costs nothing there), not on the web. Simulator: a 12px
  field the CSS rule cannot reach (inline `!important`, overlay `SMALL=1`) focused → `vv@1.00`
  (`9-b705-12px-field-max-scale.png`). No control run without the cap; B-648 measured 1.23 for a
  13px field with no cap.
- **B-706** check of the token format: `nk_` + 48 hex (51) from `tokens.ts#createToken`;
  `nkroot_` + 48 hex (55) from `root-token.ts`. `tokens.ts` says tokens minted under an older
  prefix still verify (hash lookup) — `git log -L` shows that prefix was `vrt_`, so `vrt_` + 48 hex
  is accepted too.

## Fixes

1. B-662: `platform/ios-enter-shift.ts#enterShiftIsAutoCaps` (iOS + `kb-open` + field
   auto-capitalises → the Shift is not the person's). Used by the draft's keydown and by the
   command layer's keydown dispatch (`app/CommandLayer.tsx`). The draft also treats
   `beforeinput insertLineBreak/insertParagraph` as Enter (a keydown that already decided is not
   counted twice) — defence for keyboards that send no usable keydown; not the iOS cause.
2. B-664: `app/hosts.ts#hideKeyboard` → `requestEditingEnd()` then blur; the toolbar unmounts and
   comes back at scroll 0.
3. B-661: `editor/keep-focus.ts#keepEditorFocus` — cancel `mousedown` always, `pointerdown` only for
   a non-touch pointer; marker, bullet, collapse arrow, R61 toolbar.
4. B-699: `ConnectView` hides the editable server field for a pairing link (token or code); the
   read-only `pairing-server` box is the one place the address shows.
5. B-705: `styles/shell.css` — `@media (pointer: coarse)` `input` (text-like types), `textarea`,
   `select`: `font-size: max(16px, var(--field-font-size, 1em)) !important`. Per-field B-648 rules
   removed (draft, properties, search filters, task filter). `.page-title-input` sets
   `--field-font-size` so it keeps 26px. `platform/viewport-meta.ts` (app only).
6. URL fields: web ones already had `inputmode=url autocapitalize=none autocorrect=off
   spellcheck=false` (`none` = `off` in HTML); the desktop launcher's two had none — added
   (`type=text`, not `url`, so the browser's own validation does not pre-empt ours).
7. Bare address + refused token: `connect-graph.ts#rejectedTokenMessage` — "This token isn't valid
   for the server's default graph. If it's for another graph, add /g/<graph> to the address (e.g.
   <origin>/g/work)."; the old message when a graph was named or same-origin.
8. B-706: `data/token-input.ts` — `normalizeToken` (whitespace anywhere, surrounding quotes /
   backticks / brackets, trailing `.,;:!?…)` etc.) and `tokenShapeProblem(token, "device"|"root")`
   with the exact messages, a root token in a device field and the reverse named. Wired into
   ConnectView (incl. repair; pairing-link tokens land in the same field) and the graph switcher
   (Connect: device; "Show graphs" and promote: root). The desktop launcher takes no token.

## Tests

- e2e `e2e/tests/phone-input.spec.ts` (iPhone 13, real `tap()`; chromium + webkit): B-662 ×4
  (beforeinput line break; hardware Enter once + Shift+Enter soft break; iOS shifted Return in the
  draft and in a block — both red without the fix), B-664, B-661 ×4 (marker, marker while
  editing keeps focus, toolbar buttons keep focus, bullet/collapse). 18/18.
- e2e `e2e/tests/phone-fields.spec.ts`: every form at phone size ≥ 16px (page title + properties,
  find in page, emoji picker, empty-day draft, search filters, tasks filter, settings + Devices
  add form, graph switcher add form, pairing connect screen) + switcher URL field focus
  (`visualViewport.scale` 1, no overflow). 4/4. Red with the rule's `!important` removed.
- unit: `token-input.test.ts`, `ios-enter-shift.test.ts`, `viewport-meta.test.ts`,
  `connect-graph.test.ts` (rejectedTokenMessage), `GraphSwitcher.test.tsx` (B-706 ×2, bare-address
  message), `ConnectView.test.tsx` (both refusal messages), `PairingLinkPrompt.test.tsx` (B-699,
  token and code links). Fake tokens in older tests now have the real shape.

## Simulator (iPhone 17, iOS 26.5, real Capacitor app, soft keyboard, scratch server)

Probe `tools/probes/phone-input/` (run.sh, overlay.js, XCUITest). Screenshots kept there:
`0-b662-before-shift-enter`, `1-b662-draft-return-fixed` (rows `["ab","cd"]`),
`2-b661-marker-tap-keyboard-up` (keyboard count 1 after a marker tap and after a toolbar indent
tap; server confirms TODO → DONE, block indented), `3/4/5-b664-*` (`tb@126` → toolbar gone,
`kb=0`, `act=body` → back in a block at `tb@0`), `6/7-b684-*`, `8-b705-switcher-field-focused`
(`vv=402@1.00 docW=402`), `9-b705-12px-field-max-scale`, `10/11-b699-*` (address once,
read-only, token and code links). B-706: a second graph's real token typed with a trailing `.`
into the switcher → Connect → page reloads onto it; the server shows that token `last used` at
that moment. The token screenshot is not kept (a scratch token is visible in it).

Device `phone-input-probe-afd1` deleted, scratch server stopped, `pnpm ios:sync` re-run (no
overlay in the built bundle). Note for later agents: the scratchpad is shared across the
session's agents, and an earlier agent's `scratchpad/simdata` held seeded data — use a uniquely
named data dir.

## Verification

- `pnpm --filter @nooklet/web test`: 189 files, 1653 tests passed.
- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean;
  `node tools/leak-check.mjs --tree` clean.
- Full `pnpm e2e`, run 1 (port 6520, on `aeb8dd55`): 805 passed, 2 skipped, 9 failed. 6 were
  this branch's draft tests (`phone-input.spec.ts`): a journal template set by an earlier spec
  adds rows above the typed ones — assertions now look at the tail (`c6ba6ee9`). 1 was
  `remote-device.spec.ts` typing a malformed fake token, now refused by B-706 before the server —
  given a well-shaped wrong token (`c6ba6ee9`). `plugins.spec.ts` B-610 and
  `autocomplete-inside-link.spec.ts` B-382 passed when re-run.
- Run 2 was killed partway with no summary (not by this agent; cause unknown).
- Run 3 (port 6522, on `c6ba6ee9`, 37.7 min on a loaded machine): **810 passed, 2 skipped,
  4 failed** — `commands.spec.ts` B-98 (`toBeInViewport`), `plugins.spec.ts` B-610 (again),
  `sync-connection-states.spec.ts` "a refused token says so…" (outliner not found after reload),
  webkit `phone-ui.spec.ts` B-651 toolbar cycle (marker not found). Those four specs re-run
  together: **37/37 passed**. Not checked whether B-610 also fails in a full run on `main`
  (it failed in both full runs here and passed alone both times) — order- or load-dependent.

## BUGS.md updates to fold in

- **B-662** → fixed. Cause (Simulator log with `shiftKey`): iOS's soft keyboard reports its
  auto-capitalisation shift as `shiftKey=true`, so Return arrived as Shift+Enter — the draft's soft
  line break, and `block.newline` in a block (the command layer takes Enter before CodeMirror,
  which has the same workaround internally). The draft's keydown never ran its `preventDefault`;
  iOS did not ignore it. Fix: `platform/ios-enter-shift.ts` (iOS + soft keyboard up + field
  auto-capitalises → drop the Shift), used by the draft and the command layer; the draft also
  handles `beforeinput insertLineBreak`. **Test:** `phone-input.spec.ts` "B-662: the iOS soft
  keyboard's Return (auto-capitalisation Shift) starts a block from the draft" / "…splits a block"
  (red without the fix), plus the beforeinput and hardware-Enter tests; `ios-enter-shift.test.ts`;
  Simulator `tools/probes/phone-input/0-…before…`, `1-…fixed`. Also a block's Return on the
  Simulator — previously a newline in the block when shift was lit. How often shift is lit for a
  real thumb on a physical iPhone is unverified.
- **B-664** → fixed. A blur ends nothing in `BlockTree`, so `editorFocused` stayed true. "Hide
  keyboard" now ends the editing session (`requestEditingEnd`) then blurs; the toolbar unmounts
  and comes back at its start. **Test:** `phone-input.spec.ts` "B-664: …"; Simulator `3/4/5-b664-*`.
- **B-661** → fixed. Focus is kept by cancelling `mousedown` (and `pointerdown` only for a mouse
  or pen); cancelling a touch `pointerdown` made Chromium drop the tap's `click`. Marker, bullet,
  collapse arrow and the R61 toolbar (all four were affected). `editor/keep-focus.ts`. **Test:**
  `phone-input.spec.ts` "B-661: …" ×4 with real `tap()`, Chromium + WebKit (red before in
  Chromium); Simulator: marker and toolbar taps keep the keyboard (`2-b661-*`). Android itself
  unverified (no device/emulator run).
- **B-699** → fixed. **Test:** `PairingLinkPrompt.test.tsx` (token and code link); Simulator
  `10/11-b699-*`.
- **B-684** → confirmed on the Simulator after the phone-images fix: menu on the `/` itself, in a
  block (10 ms) and in an empty day's draft (150 ms, before keyup). Event sequences in
  `docs/progress/phone-input.md`. Physical iPhone with predictive text still the owner's check.
- **B-705** → fixed. One `(pointer: coarse)` rule, `!important`, in `shell.css`; B-648's per-field
  rules removed; the iOS app also gets `maximum-scale=1` (pinch is already off in Capacitor's
  WKWebView; not on the web, where Android Chrome would lose pinch-zoom). **Test:**
  `phone-fields.spec.ts` (every form; focus keeps scale 1); `viewport-meta.test.ts`; Simulator
  `8-b705-*`, `9-b705-*`.
- **B-706** → fixed. `data/token-input.ts`: normalise (whitespace, quotes, backticks, trailing
  punctuation) and check the shape (`nk_`/`vrt_` + 48 hex = 51; `nkroot_` + 48 hex = 55) before any
  request; a root token in a device field (and the reverse) is named. **Test:**
  `token-input.test.ts`, `GraphSwitcher.test.tsx` "B-706: …" ×2; Simulator: token typed with a
  trailing `.` connects (server `last used`).
- **New (fixed, coordinator request):** a refused token for a bare server address now says the
  default graph refused it and suggests `/g/<graph>` (`rejectedTokenMessage`). **Test:**
  `connect-graph.test.ts`, `ConnectView.test.tsx` (both messages).
- **New (fixed, coordinator request):** the desktop launcher's two server-address fields had no
  `inputmode`/`autocapitalize`/`autocorrect`/`spellcheck`. No test (static HTML).
- **Note (not a bug):** a journal page emptied through the API (`block.delete` of every block)
  stays a page with 0 blocks; the app then shows an empty block, not the empty-day draft.
