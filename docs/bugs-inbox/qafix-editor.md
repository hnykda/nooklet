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

**Second cause, fixed the same day.** The Alt+ArrowUp variant then failed 2 of 2 inside a loaded
15-spec run. A focus/MutationObserver trace around the undo showed the rest of it: 10-50 ms after
the undo, a page-tree refetch that had read before the undo resolved and put the old order back,
and the next refetch restored the new one. Two more DOM moves, a `focusout` each, no `focusin`
(5 of 6 traced runs). A keystroke in that window was lost; under load the window is where the
next keystroke lands. The refetch effect now refocuses the edited block after it replaces the
rows, when the editor had focus going in (`refocusAfterReorder` again, so a real click-away is
never fought). The test now also waits 400 ms after the undo and after the redo, checks focus
synchronously, and types again: without this change Alt+ArrowUp fails there ("activeElement is
body"), with it the spec passed 6/6 in three separate runs. The flicker itself (rows jumping for
a frame) is still there; only its focus loss is fixed.

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
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q5) · **Tests:**
`e2e/tests/autocomplete-busy-replica.spec.ts` "New page links at once and keeps what is typed next,
even while the replica is busy (B-244)"; `apps/web/src/commands/autocomplete/AutocompletePopup.test.tsx`
"New page links and dismisses at once, without waiting for the page to be created (B-244)"

Fresh browser profile on the real graph, within the first seconds after load: type ` [[new/page`
and accept the "New page" row (Enter, Tab or click). The page is created and the server briefly
stores `x [[new/page]]`, but the editor still shows `x [[new/page` and the popup stays open. The
next keystroke commits the editor's buffer over it: stored `...testing [[new/pages/child after`,
an unclosed link. Accepting an existing page works; a warm client works (0/4). The owner's B-42
report was exactly `testing [[new/page`, so this may be what they hit.

**Fixed 2026-09-13.** Reproduced on a copy of the real graph with QA's `t2.mjs` against this
branch's build: EnterNew and ClickNew left `x [[qa-new/…/a` with the popup open. A timeline probe
showed why: `selectRow` awaited `pages.createPage()` before inserting the link, and that call is a
round trip to the replica worker, which answered after ~3.3 s while busy (a cold bootstrap, and
the popup's own per-keystroke block search over 18.6k blocks); after the worker went idle the same
accept took one frame. Nothing about the link needs the page to exist first (refs are keyed by
page name, `ref.dst_page_key`), so the popup now inserts `[[title]]` and dismisses synchronously
and creates the page in the background (failure is logged; a link to a missing page is an
ordinary state). The e2e test keeps the worker busy for 3 s with a synchronous loop evaluated in
it (`worker.evaluate`), presses Enter, and requires the link within 1.5 s: it failed before
("x [[busy-replica/…" after 1.5 s) and passes 3/3 after. Rerun of `t2.mjs` on the real graph after
the fix: EnterNew, TabNew, ClickNew, EnterExisting all show `x [[…]]` with the popup closed. The
same rerun is what exposed B-247 below. Whether this is what the owner saw as B-42 (focus loss) is
not established: focus stayed in the editor in every run here.

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
so whatever made it pass before is worth finding before "fixing" the test. Order matters: it
PASSED once, in a run of context-menu + focus + help + undo-redo + views on one server (views
last), and failed again right after, alone and as the whole views spec. So it depends on what
the server or client went through first, not only on the code. Not investigated further on this
branch.

---

### B-247 · An edit queued behind a busy replica worker is lost if the page reloads first
**Status:** open · **Severity:** high (silent data loss; needs a busy worker and a reload within
seconds) · **Found:** 2026-09-13, rerunning QA's `t2.mjs` for B-244 on a copy of the real graph ·
**Test:** — (probe: `tools/probes/busy-replica-reload.mjs`)

On the real graph, `t2.mjs` accepts a `[[` row and reloads the page ~1.9 s later for the next
variant. Twice (ClickNew, EnterExisting) the editor showed `x [[…]]` and the server never got it,
not even after later loads; with 5 s more before each reload, all six variants were stored. The
probe makes it deterministic: keep the replica worker busy for 4 s (a synchronous loop evaluated
in it), type ` queued`, wait 1.2 s (past the 500 ms text debounce), reload. Stored: `x`. The same
with the reload after the busy period: `x queued`. Plain typing with an idle worker and a reload
1.9 s later loses nothing (5/5).

Reading, not verified: `BlockTree.flushPendingEdit` hands the op to `applyOps`, a Comlink message
to the worker; the op only becomes durable (state + `pending_op`, one transaction) when the worker
runs it. A message still queued when the document unloads dies with the worker, and the
`pagehide` flush has the same problem. What keeps the worker busy on a big graph: the cold
bootstrap (measured ~2.2 s blocked on first load) and, plausibly, the `[[` popup's block search
(`LIKE %q%` over every block, re-run on every keystroke). A fix needs a durable hand-off that does
not wait for the worker (e.g. the unflushed edit written synchronously on the main thread and
replayed at start), which is a design decision, not a one-liner.

---

### B-245 · Cmd+X on a block selection does nothing
**Status:** open (feature gap, skipped on this branch) · **Severity:** low · **Found:**
2026-09-13, exploratory QA (Q6) · **Test:** —

Select blocks, Cmd+C copies their markdown (B-84), Cmd+X does nothing: selection, clipboard and
database unchanged. Logseq cuts. Not a regression: `keydown.ts` has no Mod+X mapping in selection
mode and `docs/spec/commands-and-keymap.md` defines no cut command. Needs a spec line (a
`block.cutSelection` = copySelection + deleteSelected as one undo step) before it is built; left
for the owner/coordinator to schedule.
