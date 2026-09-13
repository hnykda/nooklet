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
**Status:** open · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Test:** —

Select two blocks (Escape, Shift+Down), press Delete or Backspace: both go. Cmd+Z does nothing,
and focus is on `<body>` or the outliner. Much later, Cmd+Z while editing a different block brings
the deleted blocks back, which is the wrong moment. A user who deletes a selection by mistake sees
undo do nothing.

---

### B-242 · Undoing Alt+Up/Down drops editor focus; the next keystrokes are lost
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:** —

Editing `one` on `one, two, three`: Alt+Down moves it (focus kept, B-68), Cmd+Z moves it back and
the row still shows the editor, but `document.activeElement` is `<body>`. Typing `X` goes nowhere.
Undoing a Tab indent keeps focus.

---

### B-243 · On a fresh client, text typed into today's journal draft vanishes when sync says today exists
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Test:** —

The server already has today's journal with blocks. A fresh browser (empty OPFS) opens
`/journals`, the local replica does not have today yet, so the virtual draft shows; click it and
type. When the initial pull lands, the draft is replaced by the real outliner and what was typed is
in neither the UI nor the server. Focus falls to `<body>`; the sync indicator says "synced".

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

### B-245 · Cmd+X on a block selection does nothing
**Status:** open (feature gap, skipped on this branch) · **Severity:** low · **Found:**
2026-09-13, exploratory QA (Q6) · **Test:** —

Select blocks, Cmd+C copies their markdown (B-84), Cmd+X does nothing: selection, clipboard and
database unchanged. Logseq cuts. Not a regression: `keydown.ts` has no Mod+X mapping in selection
mode and `docs/spec/commands-and-keymap.md` defines no cut command. Needs a spec line (a
`block.cutSelection` = copySelection + deleteSelected as one undo step) before it is built; left
for the owner/coordinator to schedule.
