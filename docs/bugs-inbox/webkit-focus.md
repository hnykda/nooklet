# Bugs inbox — webkit-focus (M11, B-42 in WebKit on sync refresh)

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. New numbers B-501..B-509
(none used).

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
