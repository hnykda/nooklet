# Bugs inbox — qafix-editor (branch `m8/qafix-editor`)

Entries in `docs/BUGS.md` format, to be merged into it by the coordinator. Source: exploratory QA
of the editor on a copy of the owner's real graph, 2026-09-13 (findings Q1-Q6, scripts
`scratchpad/qa-editor/t1.mjs`..`t12.mjs`).

---

### B-240 · Redo of an undone new block shows it on screen, but the server never gets it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "redo of an undone Enter puts the block back on the server, not just
on screen (B-240)"; `apps/web/src/editor/history.test.ts` "create -> undo -> redo leaves the block
alive in a real database, every time (B-240)"

On `- one` / `- two`: Enter after `one`, type `mid`, Cmd+Z twice (the text, then the split: the
block goes), Cmd+Shift+Z twice. The screen shows `one, mid, two`; `page.read` returns `one, two`;
a reload shows `one, two`, so `mid` is lost. No console error. The op log for the block: create,
text, text, delete (the undo), then the redo's `block.create` logged as **noop**, then its text
applied to a block that is still a tombstone.

**Fixed 2026-09-13.** Redo re-minted the transaction's forward ops verbatim, so it re-sent the
original `block.create` for an id that already existed as the undo's tombstone; `applyOps` inserts
with `INSERT OR IGNORE`, so server and local replica did nothing while `optimistic.ts` put the row
back on screen. Redo now sends a create in its undelete form (`block.delete` with `deletedAt:
null`, `invert.ts#redoRecipe`), the op that actually reverses the undo. The existing unit test
asserted the redo was a `block.create`, i.e. it pinned the bug; it now asserts the undelete, and a
new one round-trips create/undo/redo twice through core `applyOps` on real SQLite. The e2e test
checks the server and a reload, which is what would have caught it.

---

### B-241 · Cmd+Z does nothing after deleting a block selection; the undo fires later instead
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "Cmd/Ctrl+Z right after Delete on a block selection brings the blocks
back (B-241)" (and the Backspace variant), "Cmd/Ctrl+Z after clicking away still undoes the last
edit on the page (B-241)"; `apps/web/src/app/editor-host.test.ts` "undo/redo after the editing
session ends (B-241)"

Select two blocks (Escape, Shift+Down), press Delete or Backspace: both go. Cmd+Z does nothing,
and focus is on `<body>` or the outliner. Much later, Cmd+Z while editing a different block brings
the deleted blocks back, which is the wrong moment. A user who deletes a selection by mistake sees
undo do nothing. Same cause, found while writing the test: type into a block, click away (which
ends editing since B-74), Cmd+Z: nothing.

**Fixed 2026-09-13.** `edit.undo` reaches the tree through the active `EditorHost`, and a tree
withdraws as the active host as soon as nothing in it is edited or selected, which is exactly what
deleting a selection, clicking away, or an undo that leaves nothing focused do. The keystroke went
to the inert no-op host while the tree's history kept the step. Undo and redo now fall back to the
tree whose session ended most recently (`editor-host.ts#historyEditorHost`), cleared when that
tree unmounts (`releaseEditorHost`, which also stops an unmounting tree from nulling another tree's
active registration). The fallback does not take Cmd+Z typed into an `<input>`/`<textarea>`
outside the outliner. The tree runs `edit.undo`/`edit.redo` arriving with neither an edit nor a
selection. The e2e tests fail without the change (3/3) and pass with it.

---

### B-242 · Undoing Alt+Up/Down drops editor focus; the next keystrokes are lost
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:**
`e2e/tests/undo-redo.spec.ts` "typing right after undoing or redoing Alt+ArrowDown lands in the
moved block (B-242)" (and the Alt+ArrowUp variant)

Editing `one` on `one, two, three`: Alt+Down moves it (focus kept, B-68), Cmd+Z moves it back and
the row still shows the editor, but `document.activeElement` is `<body>`. Typing `X` goes nowhere.
Undoing a Tab indent keeps focus.

**Fixed 2026-09-13.** Undo and redo of a move reorder the edited row exactly like the move itself:
the keyed `<For>` moves the row's DOM node, which blurs it. B-68's deferred refocus lived only in
`doMoveStep`; when undo/redo target the block already being edited, `doUndo`/`doRedo` just placed
the caret. The refocus is now `BlockTree.tsx#refocusAfterReorder`, called from all three. Undo of
an indent kept focus because a depth change updates the row in place. Both e2e variants fail
without the change (the X is never stored) and pass with it.

---

### B-243 · On a fresh client, text typed into today's journal draft vanishes when sync says today exists
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Tests:**
`e2e/tests/journal-draft-sync.spec.ts` "text typed into today's draft survives the first sync
saying today already exists (B-243)"; `apps/web/src/views/VirtualJournalDay.test.tsx` "torn down
with text nobody committed (B-243)" (4 tests)

The server already has today's journal with blocks. A fresh browser (empty OPFS) opens
`/journals`, the local replica does not have today yet, so the virtual draft shows; click it and
type. When the initial pull lands, the draft is replaced by the real outliner and what was typed is
in neither the UI nor the server. Focus falls to `<body>`; the sync indicator says "synced".

**Fixed 2026-09-13.** The stream picks draft or outliner from the local replica, and the draft
committed only on blur or Enter. When the snapshot flipped today to "exists", `<Show>` disposed
the draft with its text uncommitted, and nothing else looked at it. `VirtualJournalDay`'s cleanup
now keeps a non-empty uncommitted draft: it appends it as the last top-level block of the day's
page the replica now has (`data/journal-day.ts#appendToJournalDay`, an ordinary `block.create`
through `applyOps`) and, if the draft held the caret, requests focus there so typing continues at
its end. With no page for the day (unmounted for another reason) it commits the normal way. The
blur that removing a focused textarea can fire is ignored after disposal, so there is one writer.
The e2e test holds `/sync/snapshot` with `page.route` (the route reaches the sync worker's fetch)
to open the same window the 952-page graph opens by being big; it failed before (text not stored)
and passes after, 3/3 with `--repeat-each=3`.

Not covered, and not verified either way: (a) the draft committed (blur/Enter) *before* the
snapshot lands, which creates a second page for a day the server already has; core rejects a
`page.create` whose key is taken, so the typed blocks likely fail on push. (b) QA's `t7.mjs` saw
text typed immediately after Enter on a just-materialised day lost (second block stayed empty);
`a-fresh-journal.spec.ts` covers Enter-then-type but waits for focus first.

---

### B-244 · `[[` "New page" on a client still pulling its first sync writes `]]` to the database but not the editor
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q5) · **Test:** —

Fresh browser profile on the real graph, within the first seconds after load: type ` [[new/page`
and accept the "New page" row (Enter, Tab or click). The page is created and the server briefly
stores `x [[new/page]]`, but the editor still shows `x [[new/page` and the popup stays open. The
next keystroke commits the editor's buffer over it: stored `...testing [[new/pages/child after`,
an unclosed link. Accepting an existing page works; a warm client works (0/4). The owner's B-42
report was exactly `testing [[new/page`, so this may be what they hit.

---

### B-246 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at da85cfb
**Status:** open · **Severity:** low (test or focus regression, undiagnosed) · **Found:**
2026-09-13, while regression-running e2e for B-243 · **Test:** the one named

Mod+K while editing, Escape: the palette closes and `.cm-content` is never focused again
(`toBeFocused` times out, "inactive"). Fails 3/3 on port 6460: twice in the full `views.spec.ts`
with this branch's changes, and once alone and once in the full spec with `apps/web/src` checked
out at `da85cfb`, so it is not caused by this branch. The coordinator's last full run on
`a6c2859` did not list it among failures. Nothing in `apps/web/src` explicitly returns focus to
the editor when the palette closes (no `focus()` call in `CommandPalette`/`palette-controller`),
so whatever made it pass before is worth finding before "fixing" the test. Not investigated
further on this branch.

---

### B-245 · Cmd+X on a block selection does nothing
**Status:** open (feature gap, skipped on this branch) · **Severity:** low · **Found:**
2026-09-13, exploratory QA (Q6) · **Test:** —

Select blocks, Cmd+C copies their markdown (B-84), Cmd+X does nothing: selection, clipboard and
database unchanged. Logseq cuts. Not a regression: `keydown.ts` has no Mod+X mapping in selection
mode and `docs/spec/commands-and-keymap.md` defines no cut command. Needs a spec line (a
`block.cutSelection` = copySelection + deleteSelected as one undo step) before it is built; left
for the owner/coordinator to schedule.
