# keys-small: B-450, B-594, B-592

Branch: `worktree-agent-afb12b96115e5cdf1` (fast-forwarded to `main` @ `c28097a` first; the
worktree had been created on the older `f7c9644`, which has none of these entries).

## State (2026-10-03)

All three done; one commit on the branch (see `git log`). Nothing in flight.

- **B-450**: `apps/web/src/editor/BlockTree.tsx`: a standing selection ends on a `pointerdown`
  outside the outline (Logseq's rule) and on `focusin` to a button/link outside it.
  Tests: `e2e/tests/keys-in-fields.spec.ts` "Enter on a button focused outside the outline
  presses it…" and "click the title, Tab to the History link, Enter follows the link…" (both red
  with the new effect disabled, green with it).
- **B-594**: `apps/web/src/views/DiagnosticsPanel.tsx` closes on Escape (document listener +
  `claimPopupKeys`, as `HelpMenu`). Test: `e2e/tests/diagnostics.spec.ts` "closes on Escape…".
- **B-592**: `e2e/tests/autocomplete-inside-link.spec.ts` B-382 test reworked onto a link that
  names another page's alias (the one stored state where a link's page does not exist). Red with
  B-382's `createName` fix reverted, green with it.

## Verification (2026-10-03, port 6302, Chromium)

- `autocomplete-inside-link diagnostics keys-in-fields selection help focus-log palette-text-keys
  task-marker-keys`: 50 passed.
- 31 more specs that touch selection or Escape (agent-ops, commands, context-menu, dates, focus,
  focus-return, page-find, popups, refactor, ref-pages, remote-rewrite, shelf, undo-redo, views, …):
  291 passed, 1 skipped, 4 failed — exactly B-585's known four (`ref-pages.spec.ts` ×3,
  `remote-rewrite.spec.ts` "Turn into page on the row being edited"), already failing on `main`.
- `pnpm --filter @nooklet/web test`: 162 files / 1383 tests passed. `pnpm -r typecheck`: exit 0.
  `pnpm exec biome check . --diagnostic-level=error`: clean.
- Not run: the full e2e suite, WebKit, `pnpm nooklet verify` (no sync/ops/schema touched).

## What Logseq does (source read 2026-10-03, `master`)

- `src/main/frontend/components/container.cljs`
  (https://raw.githubusercontent.com/logseq/logseq/master/src/main/frontend/components/container.cljs):
  `(.addEventListener js/window "pointerdown" hide-context-menu-and-clear-selection)`;
  that function calls `editor-handler/clear-selection!` unless Shift or Meta is held, a block is
  being edited, `(util/input? target)` (INPUT/TEXTAREA), the property dialog is open, the target
  is inside `.ls-block`, or inside `[data-keep-selection]`. No focus/focusin/blur listener clears
  the selection (window `blur` only resets pointer-down state).
- `src/main/frontend/modules/shortcut/core.cljs`: Closure's `KeyboardShortcutHandler` on
  `js/window`, `.setGlobalKeys` with TAB ENTER BACKSPACE DELETE UP LEFT DOWN RIGHT. Upstream
  Closure `keyboardshortcuthandler.js#isValidShortcut_` rejects BUTTON/INPUT/TEXTAREA/SELECT
  targets unless the key is global — so Enter/Backspace/Tab fire from a focused button; `<a>` is
  not filtered at all.
- `src/main/frontend/modules/shortcut/config.cljs`: `:editor/open-edit` = `enter` →
  `open-selected-block!`; `:editor/delete-selection` = `backspace`/`delete`; `:editor/indent` =
  tab; all in `:shortcut.handler/editor-global`, guarded only by "not editing a block".
- `src/main/frontend/handler/editor.cljs`: `shortcut-delete-selection` skips only
  `(util/input? (.-target e))`; `open-selected-block!` checks only "no autocomplete open".
- Logseq DB `components/page.cljs`: the page title is rendered by `block/block-container` with
  `:page-title? true` — a block, not an always-on `<input>`.

So in Logseq: a mouse click on any non-input control outside blocks ends the selection; keyboard
focus cannot normally reach a button with a selection standing, because Tab is a global key that
indents the selection. (Enter on a *programmatically* focused button would open the block there.)

### What was implemented, and why it differs where it does

1. Pointer rule copied as is, including the `input`/`textarea` exemption (which is also B-300's
   premise: a click into the page title, the palette or the find bar keeps the selection and that
   field owns its keys). Our equivalent of `[data-keep-selection]` is the same chrome list that
   already keeps an editing session alive (`SESSION_CHROME`: popups, context menu, palette,
   mobile toolbar, help menu, shelf, zoom trail, find bar buttons). Shift/Meta/Ctrl held: kept.
2. Keyboard: here a field owns Tab (B-300), so "click title, Tab" reaches the History link with
   a selection standing — a state Logseq's Tab-indents rule never produces. To give that path
   Logseq's outcome (the control is pressed, blocks untouched), `focusin` on a
   `button, a[href], [role=button], [role=link]` outside the outline (and outside the chrome)
   ends the selection. This is the B-450 entry's second candidate, applied to buttons/links only.

Implemented in `BlockTree.tsx` next to the existing "click elsewhere ends editing" listener, not
in the command system / keymap: the change is to WHEN a selection stands, not to which key does
what, and the selection state lives in the tree. The keys → commands layer is untouched.

### Still unverified

- That Logseq's bundled Closure matches upstream `isValidShortcut_` (read upstream only).
- That Tab with a selection standing indents in Logseq rather than moving focus (read the
  binding, not the indent handler; not run in a Logseq build).
- Logseq file-graph (non-DB) page title: whether it is an input at pointerdown time — not read.
- WebKit: the B-450 e2e tests ran in Chromium only.

## BUGS.md updates to fold in

### B-450 (move to Fixed)
Replace the Status line with:
`**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, keys-in-fields · **Test:**
e2e/tests/keys-in-fields.spec.ts "Enter on a button focused outside the outline presses it, not
the selected block (B-450)" and "click the title, Tab to the History link, Enter follows the link
with a block selected (B-450)"`
and append:

**Fixed 2026-10-03 (owner decision: mimic Logseq).** What Logseq does, read from its source
(`docs/progress/keys-small.md` has the files and quotes): a window `pointerdown` listener
(`components/container.cljs#hide-context-menu-and-clear-selection`) clears the block selection
unless Shift/Meta is held or the target is an input/textarea, a block or `[data-keep-selection]`;
no focus listener clears it, but Tab is a global shortcut key there that indents the selection, so
keyboard focus never walks out of a selection to a button. `BlockTree.tsx` now (1) copies the
pointer rule, with the chrome that already keeps an editing session alive as the
`data-keep-selection` equivalent, and (2) ends the selection on `focusin` to a button or link
outside the outline — needed because here a field owns Tab (B-300), so "click title, Tab" reaches
the History link with the selection standing, a state Logseq does not produce. Effect: Enter and
Space press the focused control, Backspace there deletes nothing. A click into a text field still
keeps the selection (Logseq's `util/input?` exemption; B-300's tests rely on it). Both e2e tests
were red with the new effect disabled. Unverified: WebKit; Logseq's Tab-indents-selection is read
from its keymap, not run.

### B-594 (move to Fixed)
Status line: `**Status:** fixed · … · **Test:** e2e/tests/diagnostics.spec.ts "closes on Escape,
like every other overlay (B-594)"`, and append:

**Fixed 2026-10-03.** `DiagnosticsPanel.tsx` handles Escape as `HelpMenu` does: a `document`
keydown listener (focus on the panel or the page) plus a `claimPopupKeys` claim, so an editor
still focused underneath does not read the same Escape as "leave editing" (B-72). The test closes
it once with focus on its Close button and once with nothing focused. Not tested: Escape with a
block editor focused underneath (opening the panel takes a click, which ends editing).

### B-592 (move to Fixed)
Status line: `**Status:** fixed · … · **Test:** the reworked test itself`, and append:

**Fixed 2026-10-03.** Trashing the page after seeding does not restore the precondition — a
still-referenced page is minted again (`ref-pages.ts`: "Deleting a page that is still referenced
cannot make it go away"), checked: `page.list` still had it. The one stored state where a link's
page does not exist is a link naming another page's alias (`ref-pages.ts` deletes "unclaimed
pages whose name an alias now answers for"), and the popup's "New page" check compares titles
only, so the row is offered there. The test now seeds "Walkin Alias Holder" with
`alias:: Walkin Unmade Page`, asserts the row reads `New page "Walkin Unmade Page"` (the whole
link — B-382's fix), walks to it if ranking put another row first, presses Enter, and checks the
link is whole and no "Walkin Unm" page exists. Red with B-382's `createName` fix reverted
(no row with the whole name), green with it. If "New page" stops being offered for an alias name
(see the new entry below), this test needs another missing-page state.

### New (unnumbered): inside a `[[link]]` naming another page's alias, the popup offers "New page" for the alias name, and Enter creates a page with that name
**Status:** open, not investigated · **Severity:** low · **Found:** 2026-10-03, keys-small (B-592)
· **Test:** —

`Walkin Alias Holder` has `alias:: Walkin Unmade Page`; a block says `[[Walkin Unmade Page]]`.
Walking the caret into the link opens the `[[` popup, which lists `New page "Walkin Unmade Page"`
— `AutocompletePopup.tsx` checks `hasExact` (and `rowKeepingClosedLink`) against page titles only,
not aliases. Pressing Enter on it created a page "Walkin Unmade Page" (seen in `page.list` during
the B-592 rework, before that assertion was dropped from the test), so the alias now has a
same-named page competing with it. Expected, probably: the alias holder is the row that keeps the
link, and no "New page" for a name an alias answers. What the server does with a page whose key
equals another page's alias (link resolution afterwards) was not checked.
