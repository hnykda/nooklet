# Bug inbox — keys-in-fields (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-450..B-459.

---

### B-300 (existing)

**Severity: raise to high** (the entry's own suggestion): the palette is opened from a selection
all the time, and keys typed there wrote to blocks on the server.

**Measured again at `52e5d20` before changing anything** (`tools/probes/keys-in-fields-selection.spec.ts`,
header has every line). B-347's key list (`app/text-field-keys.ts#textFieldOwnsKey`, spec R12a),
merged after B-300 was measured on `m9/clipboard-sync`, had already fixed the reported half:
Backspace and Cmd+X in the title, and Backspace/Cmd+A/Cmd+X in the palette, edited the field and
left the blocks alone. Every key NOT on that list still ran against the outliner's context:

- title Enter with a block selected: `block.editSelected` — the block opened for editing (the
  rename still landed only because the title lost focus to the editor);
- title or palette Cmd+Shift+D: `block.duplicate` — stored `["pk one","pk one","pk two","pk three"]`;
- title or palette Cmd+.: `block.zoomIn` into the selected block;
- title Escape: `block.clearSelection`;
- palette over an open edit, Cmd+Shift+K: `format.insertLink` — stored `"pk one[]()"` in the block
  behind the palette.

**Fixed 2026-09-13**, owner-approved option (c), as: a keydown whose target is an `<input>` (any
type), `<textarea>`, `<select>` or contenteditable outside `.vr-outliner`/`.cm-editor` is dispatched
with the outliner hidden — `text-field-keys.ts#isFieldOutsideOutliner` picks the target,
`editor-host.ts#withoutOutliner` gives the dispatcher a context with nothing edited and nothing
selected (the editor snapshot's `NOTHING_FOCUSED`, `popupOpen` kept), `CommandLayer#KeyboardDispatch`
uses it. So no `editorFocused`/`blockSelected` binding can fire from such a field, and the global
`when: true` shortcuts and `pageView`'s Cmd+F still do. Not "report `blockSelected: false` while a
field has focus" in general: the palette evaluates its rows against the full context, so it still
lists and runs "Delete selected blocks", "Duplicate block" etc. Spec: new R12b in
`docs/spec/commands-and-keymap.md` (R12a unchanged, now points to it).

Tests:
- `e2e/tests/keys-in-fields.spec.ts` (7). Five fail with the one dispatch line disabled (checked
  by editing it to `false &&`, rebuilding, running, restoring): "Backspace and Cmd/Ctrl+X in the
  page title edit the title, and Enter renames the page, with a block selected" (the editor opens),
  "Cmd/Ctrl+Shift+D and Cmd/Ctrl+. in the page title leave the selected block alone" (block
  duplicated), "Backspace, Cmd/Ctrl+A then Cmd/Ctrl+X in the palette edit the query, not the selected
  block" (fails at its Cmd+Shift+D part; its Backspace/Cmd+A/Cmd+X part passed on the old code —
  B-347), "a shortcut typed into the palette over an open edit does not write into the block behind
  it" (the stored first block is not `kf one!`), "with no field focused, a standing selection still answers
  Backspace and Cmd/Ctrl+X, also after the palette or the page title had focus" (fails at the title
  part; its no-field Backspace and after-palette Cmd+X parts are guards). Guards that pass either
  way: "over a block selection, the keys meant for a field still work there", "the global shortcuts
  still fire from the search box and from a settings field".
- `apps/web/src/app/text-field-keys.test.ts` › "isFieldOutsideOutliner (B-300)" and "the default
  keymap, typed into a field outside the outliner (B-300)": every single-key binding of the real mac
  keymap, dispatched from a field over a context where an edit AND a selection stand, reaches
  exactly `app.openSettings, app.toggleSidebar, nav.back, nav.forward, nav.journals, nav.switchPage,
  nav.todayJournal, palette.open, search.findInPage, search.open` — a new binding that can act on a
  block from a field shows up here.

Commands meant to fire from a field, each checked (e2e runs on port 6411, Chromium, macOS):

| From | Keys | Owner of the key | How checked |
|---|---|---|---|
| Palette query | ArrowUp/ArrowDown/Enter/Shift+Enter | the input's own `onKeyDown` (plus the popup claim) | keys-in-fields › "keys meant for a field" (arrows + Enter run "Duplicate block" over a selection); `views.spec` "the palette runs a command from the keyboard…", "Enter on a highlighted page in the palette opens it"; `commands.spec` "Shift+Enter on a page in the palette shelves it…" — green |
| Palette query | Escape | input + popup claim | `views.spec` "Escape and a backdrop click both close the palette"; `focus-return.spec` (all 8); keys-in-fields › tests 3, 4, 5 — green |
| Palette query | Cmd+K (closes) | `palette.open`, `when: true` — still dispatched | keys-in-fields › "keys meant for a field"; `views.spec` "…Cmd/Ctrl+K toggles"; `focus-return.spec` "Cmd/Ctrl+K pressed again to close the palette…" — green |
| Page title | Cmd+K (opens) | `palette.open` | keys-in-fields › "keys meant for a field" — green |
| Page title | Enter (commit), Backspace, Cmd+A/X | the textarea | keys-in-fields › test 1 (over a selection); `page-rename.spec`, `page-title-draft.spec` — green |
| Find bar | Cmd+F inside it, Enter/Shift+Enter, Escape | Cmd+F: `search.findInPage` (`pageView`, still dispatched); the rest: the input's `onKeyDown` | keys-in-fields › "keys meant for a field" (over a selection); `page-find.spec` (all) — green |
| Date picker | typed line, arrows, Enter, Escape | its own WINDOW-capture listener (nothing focusable; the editor keeps focus, so not a field) | unchanged by construction; `dates.spec`, `date-picker-type-ahead.spec` — green |
| Template picker | filter letters, arrows, Enter, Escape | its own document-capture listener (nothing focusable) | unchanged by construction; `templates.spec`, `template-undo.spec` — green |
| Move to page… / Merge into… picker | typing, arrows, Enter, Escape | the input's `onKeyDown` + popup claim | `refactor.spec` (incl. "Escape moves nothing"), `focus-return.spec` "Move to page…" tests — green |
| Settings | Cmd+K from a focused setting; Cmd+, | `when: true` | keys-in-fields › "global shortcuts … from a settings field"; `settings.spec` — green (2 tests skip themselves: "sqlite-vec did not load on this server", as before) |
| Search box | Cmd+J (and every `when: true` shortcut) | `when: true` | keys-in-fields › "global shortcuts … from the search box"; `views.spec` "Cmd/Ctrl+J, Cmd/Ctrl+Shift+F and Cmd/Ctrl+Shift+J go where they say"; `search-cleared.spec`, `search-filters.spec` — green |
| Journal draft (`.vr-draft-input`) | Enter starts the day | the textarea's `onKeyDown` | `journal-day-start.spec` — green (without a selection standing elsewhere; with one, Enter used to be `block.editSelected` — not e2e-checked) |
| Page properties, page icon, trash rename, capture, page finder | Enter/Escape | each input's own `onKeyDown`; none uses the keymap | read, not run with a selection standing |

Related set run together after the fix (before the 7th keys-in-fields test was added): the specs in
the table plus `selection`, `popups`, `help`, `navigation`, `phone-palette`, `undo-redo`, `redo`,
`context-menu`, `page-icons` — 216 passed, 1 skipped, 0 failed.

Behaviour changes to know about:
- Escape typed in a field outside the outliner no longer clears a standing block selection (it did
  from the title; the palette, find bar and pickers already took Escape themselves).
- Cmd+Shift+. (`block.zoomOut`, `when: zoomed`) no longer fires from a field: `zoomed` is part of
  the outliner's snapshot, hidden with the rest.
- A `<select>` and non-text inputs (date, checkbox) count as fields for R12b but not for R12a, so
  arrows on a focused `<select>` no longer extend a block selection. Mod+Z on a focused `<select>`
  still runs `edit.undo` (`when: true`, not an editing key there), and `historyEditorHost` only
  declines for an input or textarea — so it may still undo the outliner's last step, as before this
  change. Not checked in a browser.

Still unverified: Windows/Linux bindings (all runs were on macOS with Meta); WebKit (the Mac app) —
the rule is DOM-only (`closest`, `instanceof`, `isContentEditable`) with nothing engine-specific, but
not run there; a plugin command bound to a key with a block-scoped `when` is hidden from fields by
the same rule (by design) — no plugin with a keybinding exists to try it with.

---

### B-450 · With a block selection standing, Enter on a focused button opens the block instead of pressing the button

**Status:** open (needs owner decision: whether buttons join B-300's rule) · **Severity:** low · **Found:**
2026-09-13, keys-in-fields (checking what B-300's fix leaves out) · **Test:** — (probe:
`tools/probes/keys-in-fields-selection.spec.ts`, "on a focused button")

Select a block (Escape), focus a button outside the outliner (`.help-fab`, focused with
`locator.focus()`; whether a mouse click leaves a button focused differs by engine — not checked),
press Enter: the button is not activated (help menu stays shut) and the
selected block opens for editing — `block.editSelected` matches in the capture-phase dispatcher and
prevents the default. Space does activate the button (nothing binds Space). Backspace on the focused
button deletes the selected block on the server — arguably intended (the selection is still what the
keyboard acts on), which is why this is a decision, not a bug fix: B-300's option (c) named
inputs, textareas and contenteditables only. Candidates: count `button`/`[role=button]`/`a[href]`
as fields for Enter and Space only; or end a standing selection when focus moves to a control
outside the outliner.
