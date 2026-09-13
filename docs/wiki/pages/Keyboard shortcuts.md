type:: reference
summary:: Every command nooklet registers, with its default keys on macOS and on Windows/Linux. Generated from the code, not written by hand.
tags:: reference

- **Generated on 2026-09-13** from `apps/web/src/commands/registrations/*.ts` by `docs/wiki/tools/generate-shortcuts.mjs`. Do not edit this page by hand; re-run the generator (`node docs/wiki/tools/generate-shortcuts.mjs`).
- 90 commands are registered; 48 have a default key. The same list, limited to bound keys, is in the app under the `?` button in the corner → Keyboard shortcuts, built from the live keymap.
- "When" is the condition under which the key does this ([[Concepts]] explains `editorFocused` and `blockSelected`). One key can do different things in different states: Enter splits a block while editing and starts editing a selected block.
- Keys are meant to be rebindable through a user-editable `keybindings.json` (ADR 009, `docs/spec/commands-and-keymap.md` §I). The keymap merge rules exist in `apps/web/src/commands/keymap/`; a settings screen for editing them is not built.
- ## Block
- | Command | macOS | Windows / Linux | When |
  |---|---|---|---|
  | Split block (`block.split`) | Enter | Enter | `editorFocused` |
  | Insert newline in block (`block.newline`) | Shift+Enter | Shift+Enter | `editorFocused` |
  | Indent block (`block.indent`) | Tab | Tab | `editorFocused` |
  | Outdent block (`block.outdent`) | Shift+Tab | Shift+Tab | `editorFocused` |
  | Merge with previous block (`block.mergeWithPrevious`) | Backspace | Backspace | `editorFocused && atLineStart && !hasSelection` |
  | Merge next block into this one (`block.deleteForwardMerge`) | Delete | Delete | `editorFocused && atLineEnd && !hasSelection` |
  | Move block up (`block.moveUp`) | Alt+Up | Alt+Up | `editorFocused \|\| blockSelected` |
  | Move block down (`block.moveDown`) | Alt+Down | Alt+Down | `editorFocused \|\| blockSelected` |
  | Move to previous block (same column) (`block.focusPreviousLine`) | Up | Up | `editorFocused && onFirstVisualLine` |
  | Move to next block (same column) (`block.focusNextLine`) | Down | Down | `editorFocused && onLastVisualLine` |
  | Move to end of previous block (`block.focusPreviousChar`) | Left | Left | `editorFocused && atLineStart` |
  | Move to start of next block (`block.focusNextChar`) | Right | Right | `editorFocused && atLineEnd` |
  | Collapse block (`block.collapse`) | Cmd+Up | Ctrl+Up | `(editorFocused \|\| blockSelected) && hasChildren && !isCollapsed` |
  | Expand block (`block.expand`) | Cmd+Down | Ctrl+Down | `(editorFocused \|\| blockSelected) && hasChildren && isCollapsed` |
  | Zoom into block (`block.zoomIn`) | Cmd+. | Ctrl+. | `editorFocused \|\| blockSelected` |
  | Zoom out (`block.zoomOut`) | Cmd+Shift+. | Ctrl+Shift+. | `zoomed` |
  | Select block (`block.selectBlock`) | Escape | Escape | `editorFocused && !popupOpen` |
  | Edit selected block (`block.editSelected`) | Enter | Enter | `blockSelected` |
  | Clear selection (`block.clearSelection`) | Escape | Escape | `blockSelected` |
  | Extend selection up (`block.extendSelectionUp`) | Shift+Up | Shift+Up | `editorFocused \|\| blockSelected` |
  | Extend selection down (`block.extendSelectionDown`) | Shift+Down | Shift+Down | `editorFocused \|\| blockSelected` |
  | Select all blocks (`block.selectAll`) | Cmd+A | Ctrl+A | `blockSelected` |
  | Delete selected blocks (`block.deleteSelected`) | Backspace, Delete | Backspace, Delete | `blockSelected` |
  | Indent selected blocks (`block.indentSelected`) | Tab | Tab | `blockSelected` |
  | Outdent selected blocks (`block.outdentSelected`) | Shift+Tab | Shift+Tab | `blockSelected` |
  | Copy selected blocks as markdown (`block.copySelection`) | Cmd+C | Ctrl+C | `blockSelected` |
  | Duplicate block (`block.duplicate`) | Cmd+Shift+D | Ctrl+Shift+D | `editorFocused \|\| blockSelected` |
  | Copy block reference (`block.copyRef`) | Cmd+Shift+C | Ctrl+Shift+C | `editorFocused \|\| blockSelected` |
  | Paste (`edit.paste`) | Cmd+V | Ctrl+V | `editorFocused` |
- ## Task
- | Command | macOS | Windows / Linux | When |
  |---|---|---|---|
  | Cycle task marker (`task.cycle`) | Cmd+Enter | Ctrl+Enter | `editorFocused \|\| (blockSelected && selectionCount == 1)` |
- ## Navigation
- | Command | macOS | Windows / Linux | When |
  |---|---|---|---|
  | Open command palette (`palette.open`) | Cmd+K, Cmd+Shift+P | Ctrl+K, Ctrl+Shift+P | `true` |
  | Switch page (`nav.switchPage`) | Cmd+O | Ctrl+O | `true` |
  | Open today's journal (`nav.todayJournal`) | Cmd+J | Ctrl+J | `true` |
  | Open journals (`nav.journals`) | Cmd+Shift+J | Ctrl+Shift+J | `true` |
  | Go back (`nav.back`) | Cmd+[ | Alt+Left | `true` |
  | Go forward (`nav.forward`) | Cmd+] | Alt+Right | `true` |
  | Follow link under cursor (`nav.followLink`) | Alt+Enter | Alt+Enter | `editorFocused && caretInLink` |
  | Open search (`search.open`) | Cmd+Shift+F | Ctrl+Shift+F | `true` |
- ## Formatting
- | Command | macOS | Windows / Linux | When |
  |---|---|---|---|
  | Bold (`format.bold`) | Cmd+B | Ctrl+B | `editorFocused` |
  | Italic (`format.italic`) | Cmd+I | Ctrl+I | `editorFocused` |
  | Strikethrough (`format.strikethrough`) | Cmd+Shift+X | Ctrl+Shift+X | `editorFocused` |
  | Highlight (`format.highlight`) | Cmd+Shift+H | Ctrl+Shift+H | `editorFocused` |
  | Inline code (`format.inlineCode`) | Cmd+E | Ctrl+E | `editorFocused` |
  | Insert link (`format.insertLink`) | Cmd+Shift+K | Ctrl+Shift+K | `editorFocused` |
- ## App
- | Command | macOS | Windows / Linux | When |
  |---|---|---|---|
  | Undo (`edit.undo`) | Cmd+Z | Ctrl+Z | `true` |
  | Redo (`edit.redo`) | Cmd+Shift+Z | Ctrl+Shift+Z | `true` |
  | Toggle sidebar (`app.toggleSidebar`) | Cmd+\ | Ctrl+\ | `true` |
  | Open settings (`app.openSettings`) | Cmd+, | Ctrl+, | `true` |
- ## Secondary bindings
- A few keys are bound on top of a command's own default (`apps/web/src/commands/keymap/secondary-defaults.ts`):
  - `Delete` → `block.deleteSelected` when `blockSelected`
  - `Cmd+Shift+P` → `palette.open`
  - `Ctrl+Shift+P` → `palette.open`
- ## Commands without a default key
- Reachable from the command palette (Cmd/Ctrl+K), the slash menu (`/` at the start of a line), the block context menu, or the phone toolbar. Listed so the palette holds no surprises.
  - **Block**: Collapse all (`block.collapseAll`) · Expand all (`block.expandAll`) · Turn into page (`block.turnIntoPage`) · Move to page… (`block.moveToPage`) · Open on shelf (`block.openOnShelf`)
  - **Task**: Toggle done (`task.toggleDone`) · Mark TODO (`task.setMarkerTodo`) · Mark DOING (`task.setMarkerDoing`) · Mark WAITING (`task.setMarkerWaiting`) · Mark CANCELED (`task.setMarkerCanceled`) · Mark DONE (`task.setMarkerDone`) · Clear task marker (`task.clearMarker`) · Set priority A (`task.setPriorityA`) · Set priority B (`task.setPriorityB`) · Set priority C (`task.setPriorityC`) · Set scheduled date (`task.setScheduled`) · Set deadline date (`task.setDeadline`)
  - **Navigation**: Find and replace… (`search.findReplace`) · Open this page on shelf (`nav.openPageOnShelf`)
  - **Formatting**: Insert page reference (`format.insertPageRef`) · Insert tag (`format.insertTag`) · Insert block reference (`format.insertBlockRef`)
  - **Insert**: Heading 1 (`block.setHeading1`) · Heading 2 (`block.setHeading2`) · Heading 3 (`block.setHeading3`) · Code block (`block.insertCodeFence`) · Query (`block.insertQueryFence`) · Table (`block.insertTable`) · Image (`block.insertImage`) · Embed page (`block.embedPage`) · Embed block (`block.embedBlock`) · Today's date (`block.insertToday`) · Property (`block.insertProperty`) · Open slash menu (`block.openSlashMenu`) · Insert template… (`block.insertTemplate`)
  - **App**: Open plugin manager (`app.openPluginManager`) · Sync now (`sync.now`) · Toggle theme (`app.toggleTheme`) · Hide keyboard (`app.hideKeyboard`) · Merge this page into… (`edit.mergePage`)
- ## Commands that need arguments
- Not in the palette: each does nothing without its payload. Agents run them through the live UI channel; a `keybindings.json` row can bind one with `args`.
  - Open page (`nav.openPage`)
  - Reveal block (`nav.revealBlock`)
