# Bugs inbox — rv-merge-web (M9 review of the M8 merge resolutions in the web client)

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator. One number per review
finding (F1–F5, `docs/review/2026-09-13-rv-merge-web.md`): B-360–B-364. Each is a defect neither
parent branch had on its own — two changes that were correct apart and met in a merge.

---

### B-360 · `/template` into an empty bullet that has a property puts the caret in the property line
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, merge-resolution review (F1) ·
**Test:** `e2e/tests/templates.spec.ts` "/template into an empty numbered item: what is typed next
extends the text, not the list property (B-360)"

Pick a template with `/template` in an empty numbered item (`list:: number`), or in any empty
bullet with a property line, and type: the characters go into the property's value, not after the
template's text. `list:: number` becomes `list:: numberx`, the item stops being numbered, and the
typed text is not in the block's content.

`BlockTree.runStructural`'s branch for a batch whose focus stays on the block being edited (B-108)
calls `surface.setCaret(res.focus.caret)` with a content-relative caret. Since B-101 the buffer
holds property lines after line 1, and `{at: "end"}` becomes the end of the buffer — the end of the
last property line. The impl-render merge converted `doUndo`/`doRedo` to `bufferCaret()` but not
this branch, and dropped the B-154 unit assertions on the caret instead of porting them.
`docs/BUGS.md` B-154's "through `onContent` … the caret ends after the text" no longer describes
the code (the text now arrives as a `block.text` op in a `commitOps` batch).

**Fixed 2026-09-13.** The same-block branch maps the caret into the buffer with `bufferCaret()`, as
`doUndo`/`doRedo` do. The e2e test (seed `- first` / `list:: number`, Enter, `/template` daily, type
`!`) failed first against the unfixed build — stored `{content: "Daily plan for [[Sep 13th,
2026]]", properties: {list: "number!"}}` — and passes with the fix. **For the coordinator:** B-154's
Fixed paragraph in `docs/BUGS.md` should say the template's text arrives as a `block.text` op in a
`commitOps` batch (not through `onContent`), and that the caret after it was wrong until B-360.

---

### B-361 · Escape from find in page puts the caret back in the wrong place in a block with properties
**Status:** open · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F2) ·
**Test:** none yet

Edit a block that has a property line, put the caret anywhere below its first line, press
Cmd/Ctrl+F, then Escape: the caret comes back further along than it was — by the length of the
property lines — or at the end of the block.

`openPageFind` stores `editing.end` as the caret to return to. That is an offset into the CM6
buffer (property lines included, B-101); on Escape the tree maps it into the buffer a second time
as if it were an offset into the content (`caretInEditText`). Find in page was written before
B-101 existed on its branch.

---

### B-362 · Cmd/Ctrl+Z on a page that was just locked still undoes into it
**Status:** open · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F3) ·
**Test:** none yet

Edit a block, then have the page locked (`read-only:: true` from the properties panel, another
device, or an agent). Editing ends, as B-234 intends. Now press Cmd/Ctrl+Z with focus on the page:
the last edit is reverted and written to the locked page.

Undo after a session ends goes to the most recent tree (B-241, `historyEditorHost`), and with no
editor and no selection `BlockTree`'s host calls `doUndo()`/`doRedo()`, which never check the lock.
The lock's own guard is in `onContainerKeyDown`, which this path does not pass through.

---

### B-363 · Printing with the find bar open prints the bar and only the matching blocks
**Status:** open · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F4) ·
**Test:** none yet

With find in page open and a query typed, Print page (menu, palette, or Cmd/Ctrl+P) puts the find
bar on paper above an outline cut down to the matches and their (faded) ancestors; collapsed
children are not expanded either.

`BlockTree`'s rows are `filtered()?.rows ?? flattenVisible(…, {expandAll: isPrinting()})`, so an
active filter wins over printing (B-221 and find in page met in a merge), and `print.css` hides the
page's other controls but not `.page-find`.

---

### B-364 · `BlockTree.tsx`'s header says `{{embed}}` renders a placeholder
**Status:** open · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F5) ·
**Test:** none (comment only)

The header's "Known data-seam gaps" says `{{embed}}` renders a placeholder rather than a live tree,
pointing to `render/tokens.tsx`. Embeds render their target read-only through `EmbedView` since
B-210; the impl-render merge rewrote the sentence before impl-embeds landed.
