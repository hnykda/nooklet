# Bugs inbox — webkit-focus (M11, B-42 in WebKit on sync refresh)

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. New numbers B-501..B-509
(B-501 used by the branch; B-502 used by its verification).

---

### B-42 (existing)

**Still open, still not reproduced — now also not in WebKit (2026-09-13, m11/webkit-focus).** The
owner's report of today (desktop app, WKWebView, focus lost when the app syncs while `[[dru` sits
in the popup) pointed at the engine, and every earlier attempt had run in Chromium. So the same
scenario was traced in Playwright's WebKit (26.x, `webkit-2359`) next to Chromium, recording from
page load: `focusin`/`focusout` with `relatedTarget` and stack, window blur, every
`focus()`/`blur()` call with stack, every DOM insertion/removal/move of a node that contains the
focused element with stack, and `activeElement` / editor row / popup / sync indicator every 20 ms.

Not reproduced in any of these — 0 unfocused samples, 0 `focusout`, 0 DOM operations on the focused
subtree in WebKit, and a key typed afterwards lands in the block with the popup still open:

- **e2e graph, WebKit and Chromium** (probe `tools/probes/webkit-refresh-focus.spec.ts`): existing
  block and new block (Enter) in today's journal, with (a) nothing but this client's own cycle — the
  500 ms flush, push, push queue draining (syncVersion), (b) an API write to another block on the
  same page, (c) an API write to another page.
- **Copy of the owner's graph** (953 pages, 18,631 blocks; probe
  `tools/probes/webkit-refresh-focus-real-graph.mjs`), in today's journal, which holds
  `((1m287mdbqzg37p))` → "travel/trip-planning": the same three refreshes plus a new block, plus a day
  started from its draft (the owner's today page was created minutes before the report, so the tree
  is the one `VirtualJournalDay` renders). The refreshes demonstrably happened: B-500's `((id))`
  flash is in the trace each time. WebKit variants: pointer resting on the popup, pointer resting
  below the editor, every animation frame 120 ms late, 700 ms between keys.
- `document.hasFocus()` stayed true; no `window` blur.

Ruled out by the traces: a keyed `<For>` moving or re-inserting the edited row on a refresh (no
row moves — the edited row's DOM is never touched), the popup re-rendering (its rows re-render only
on keystrokes; it does not listen to sync), `CommandLayer`'s re-detect (keyup/pointerup only), the
"pointerdown outside ends editing" listener (no pointer events), the tree effect's
refocus-after-reorder and `surface.attach`'s frame backstop (neither ran during a refresh). Escape
with the popup open after a refresh still closes the popup and keeps editing (checked at 0 / 300 /
700 / 3000 ms, both engines).

What Playwright's WebKit does not share with the desktop app, none of which could be exercised here:
the system WKWebView build (macOS 26) rather than Playwright's; OPFS in the worker (Playwright's WebKit
has none and runs the in-memory replica, so every refresh reads from memory rather than a
18k-block OPFS database); a real window and the macOS text input client — inline predictions,
autocorrect (`autocorrect: on`, `spellcheck: true` on the editor), marked text, the Czech layout's
Option-typed `[`; a real pointer. Headed WebKit was not run: it would open a window that takes the
keyboard from the owner's session on the same machine.

**Instrumentation for the owner** (commits on m11/webkit-focus): Diagnostics (click the sync
indicator) → **Focus log** → tick "Record focus changes", close, reproduce, reopen Diagnostics →
"Copy log" (or "Show log" and copy from the box). It records the above plus the editor attaching and
detaching (with the stack that detached it), replica change events, sync status transitions, key
categories (`char`, `Enter`, never the character), `beforeinput` input types (an
`insertReplacementText` would point at autocorrect), composition start/end, pointer targets, and a
`LOST` line the moment the editor stops holding focus. No typed text, no page names. It stays on
across a reload, with the previous load's entries, until unticked. `nookletFocusLog.text()` in a
console does the same. Code: `apps/web/src/app/focus-log.ts`.

Tests added (guards, not a fix): `e2e/tests/webkit-refresh-focus.spec.ts` (3; runs in chromium AND
webkit — all six runs fail against a build that blurs on every replica change, all pass on this
branch), `e2e/tests/focus-log.spec.ts` (2, both projects), `apps/web/src/app/focus-log.test.ts` (8).

**Next, needs the owner:** a focus log from the desktop app covering one loss.

---

### B-501 · In WebKit, Alt+Up/Down moves the block but the caret jumps to the start of it
**Diagnosed and fixed 2026-09-13 (verification):** the same DOM-move mechanism as B-502 below,
same fix. Test `e2e/tests/edited-row-move-caret.spec.ts` "Alt+Up moves the block being edited
without moving the caret (B-501)" failed in WebKit (caret 0) before, passes after; Chromium both.

**Status:** needs-repro (in the desktop app) · **Severity:** low · **Found:** 2026-09-13,
m11/webkit-focus, running `focus.spec.ts` in Playwright's WebKit · **Test:** `e2e/tests/focus.spec.ts`
"Alt+Up/Down moves the block and keeps the editor in it (R22)" fails in WebKit (it runs only in
Chromium in the suite)

Editing `two` on `one, two` with the caret at the end, Alt+ArrowUp: the block moves up and the
editor keeps focus, but the caret is at offset 0 instead of 3 (`{anchor: 0, head: 0}`). Chromium
keeps it at 3. Same result on `52e5d20` (this branch's base) with none of this branch's changes, so
not caused by the focus log. Not yet checked in the real desktop app (WKWebView), where it would
matter; not diagnosed. A guess worth testing first, not a finding: the keyed `<For>` moves the row's
DOM node, WebKit resets the document selection when the focused node moves, and CodeMirror reads
that selection back on refocus instead of writing its own.

For the record, the same WebKit run (`popups`, `focus`, `focus-return`, `editing`,
`editing-row-leaves`, `autocomplete`, `autocomplete-busy-replica`, `follow-link-popup`,
`journal-stream-editing`, `diagnostics`, `storage`, `webkit-refresh-focus`, `focus-log`: 101
passed, 6 failed) had five more failures, all of one kind and all also failing on `52e5d20`: a
reload or `page.goto` shortly after typing (`editing.spec.ts` "text survives blurring…", "Enter
creates a second bullet…", "typing immediately after Enter…"; `focus.spec.ts` "text typed just
before an in-app navigation…"; `popups.spec.ts` "Table on an empty block…"), each at its first
assertion after the reload or `goto` (lines 69, 98, 134, 382, 594). Playwright's WebKit has no OPFS
in workers and runs the in-memory replica (B-43), whose queue of unpushed ops dies with
the page — expected there, and why the webkit project does not run the suite. Not a bug by itself.

---

### B-502 · In WebKit, a refresh that moves the block being edited puts the caret at the start, with the `[[` popup left open
**Status:** fixed (in Playwright's WebKit; not checked in the desktop app) · **Severity:** medium (the Mac app's engine; the next keystroke lands in the wrong
place) · **Found:** 2026-09-13, verifying m11/webkit-focus (probe
`tools/probes/refresh-focus-structural.spec.ts`) · **Test:**
`e2e/tests/edited-row-move-caret.spec.ts` "another device moving the block you are typing a link
into keeps the caret and the popup (B-502)" (chromium + webkit)

Type `base testing [[dru` in a block so the `[[` popup is open. Another device (here an API
`block.move`) moves that block above its sibling. After the pull: in Playwright's WebKit the editor
still has focus but the caret is at offset 0, the popup is still showing, and the next key types at
the START of the block (`gbase … testing [[dru`) and closes the popup. Chromium keeps the caret at
the end and `g` completes `[[drug`. The verification's other structural refreshes (a block inserted
above, siblings reordered around the edited one, the edited block indented, a child added above, a
real second client editing the block below, typing straight through remote inserts) keep focus and
caret in both engines.

Mechanism, traced (probe `tools/probes/edited-row-move-mechanism.spec.ts`, which logs activeElement
and the DOM selection around the native `insertBefore`, `selectionchange`, focus events and
`focus()` calls): the keyed `<For>` moves the edited row's node; in BOTH engines `activeElement`
becomes `<body>` and `BlockTree.tsx#refocusAfterReorder` calls `surface.focus()` in a microtask.
Chromium fires `focusout` on the move, CM6's blur handler clears its cached DOM selection, and
`view.focus()` writes the state's caret back (head 46 → 46). WebKit fires NO `focusout`: CM6 keeps
the stale cache, its `updateSelection` compares the state with that cache, finds them equal and
writes nothing, while WebKit's own focus has put the DOM caret at the start of the content; the
`selectionchange` that follows is read into the state (head 44 → 0).

Same cause as B-501 (Alt+Up/Down), which is the same DOM move made locally. Whether it is what the
owner sees as B-42 is not established: the owner's report (pause mid-link, a refresh, focus gone)
does not involve anything moving the block, and this leaves the editor focused rather than
unfocused.

**Fixed 2026-09-13** in `editor/surface.ts#focus` (the only caller is `refocusAfterReorder`): after
`view.focus()`, if the document selection disagrees with the editor state, write the state's
selection into it in the same task, before any `selectionchange` — the repair
`commands/focus-return.ts` already makes for B-296. No timer, no BlockTree change. The test above
fails in WebKit before (2/2, caret 0) and passes after (2/2), Chromium passes both.
