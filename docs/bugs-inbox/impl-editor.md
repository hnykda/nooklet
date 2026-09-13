# Bugs inbox — impl-editor (m8)

Entries in `docs/BUGS.md`'s format, to be merged into it by the coordinator. Existing bugs keep
their numbers; new ones take B-190..B-199.

---

### B-108 (existing)
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
`e2e/tests/template-undo.spec.ts` "Cmd/Ctrl+Z takes back a template inserted into an empty bullet,
and redo restores it" and "Cmd/Ctrl+Z takes back a template inserted after a bullet with text,
caret back where it was", and "undo and redo of a nested template with a marker and a property on
the bullet" (added by the verification pass); `apps/web/src/editor/external-batch.test.ts`;
`apps/web/src/commands/registrations/templates.test.ts`

Unchanged from `docs/BUGS.md`: a template inserted with `/template` stays after Cmd/Ctrl+Z.
Before the fix both e2e tests failed at the undo: into an empty bullet, the text went back but the
template's children stayed (the text was the only part that went through the editor); after a
bullet with text, nothing changed at all.

**Fixed 2026-09-13.** A new `EditorHost.commitOps(batch)` seam (`commands/hosts/editor-host.ts`,
bridged in `app/editor-host.ts`) lets a command hand the tree ops it built itself; `BlockTree`
validates and re-mints them (`editor/external-batch.ts#prepareExternalBatch`) and commits them
through `runStructural`, the path a split takes — one history transaction. `data/templates.ts`
now builds the ops without applying them (`templateAfterOps`, `templateIntoBlockOps`, the latter
with the first line's text as a `block.text` op instead of an `EditorHost.replaceRange`), and the
command falls back to `applyOps` only when no mounted tree shows the block. `runStructural` now
places the caret when the focus stays on the block being edited (it used to call
`attachEditing` with the same id, which re-renders nothing). ADR 019 amended. The redo half of the
test also exposed B-190, fixed separately.

One gotcha for whoever touches the e2e: every spec shares one server, and a template left in the
graph changes `templates.spec.ts`'s Settings list; `template-undo.spec.ts` deletes its library
after each test for that reason.

---

### B-88 (existing)
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, `e2e/tests/refactor.spec.ts` ·
**Test:** `e2e/tests/editing-row-leaves.spec.ts` "a block deleted elsewhere while the caret is in it
leaves the page", "a block moved to another page while the caret is in it leaves, and what was
typed goes with it", "Move to page… on the row being edited takes the row away and the text typed
just before" and "a block brought back by undo keeps its row while typing straight away" (the last
two added by the verification pass, below); `apps/web/src/editor/unseen-creations.test.ts`

Unchanged from `docs/BUGS.md`: the row holding the editor stays on screen, showing the old text,
after its block is moved to another page or deleted elsewhere. Before the fix both e2e tests
failed the same way: the pull landed (the block's child row went) and the edited row was still
there, editor and all, ten seconds later.

**Fixed 2026-09-13.** The cause was the `else` branch of `BlockTree`'s tree effect: any refetch
without the block being edited was taken for an optimistic creation not yet committed, and the
local row was kept. The tree now remembers which blocks it created or revived that no refetch has
returned yet (`editor/unseen-creations.ts`, fed from `commit`, `doUndo`, `doRedo`); only those keep
their row. A block the database had, missing from a later refetch, has left: the tree flushes
pending keystrokes (written to the block by id, wherever it went — the move test checks
`"goes typed"` arrives on the destination page), detaches the editor and ends editing. The "Move
to page…" workaround in `commands/registrations/refactor.ts` is gone. "Turn into page" still ends
editing before its op, for a different reason found while removing it: the block is rewritten,
not moved, and the editor keeps a stale buffer over an external rewrite — logged as B-192.

Not covered: a block created in this tab and removed elsewhere before any refetch has returned it
keeps its row until editing ends (a window one refetch long).

---

### B-190 · Redo of an undone Enter, paste or duplicate shows the block but never writes it
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, writing the redo half of
B-108's test · **Test:** `e2e/tests/redo.spec.ts` "redo after undoing Enter brings the new block
back in the database, not only on screen"; `apps/web/src/editor/history.test.ts` "undoing a split
(block.create) deletes the new block; redoing revives it"

Press Enter in a block (a new bullet), Cmd/Ctrl+Z (it goes), Cmd/Ctrl+Shift+Z: the bullet is
back on screen, but `page_read` does not list it, and a reload loses it along with anything typed
into it since. Same for any undone structural command that created blocks — split, multi-line
paste, duplicate, and now `/template`. `EditHistory.redo` re-mints the transaction's forward ops,
so the redo of a create is another `block.create` for the same id; the reducer's
`applyBlockCreate` is `INSERT OR IGNORE`, and the row the undo tombstoned is still there, so the
redo is a no-op in the database. The optimistic tree does not know that and shows the block.

Verified before the fix: the e2e failed on the API read (`["first"]`), and with that assertion
taken out, on the reload (`["first"]` again) — so the loss is real, not a slow sync. The unit test
of the same name existed and passed: it asserted only that the redo re-emitted a `block.create`.

**Fixed 2026-09-13.** `editor/history.ts#redoRecipes`: a redo follows each forward `block.create`
with a revive (`block.delete`, `deletedAt: null`) for the same id, minted after the undo's
tombstone so the reducer does not call it stale. Editor-side on purpose: making `block.create`
revive a tombstoned row in `@nooklet/core` would change what replaying the op log means, for every
device and `nooklet verify`. The unit test now asserts the revive and its ordering; the e2e above
would have caught it (it failed before the fix, passes after).

---

### B-191 · Undo of `/template` into a bullet that already had one of the template's properties removes it
**Status:** open · **Severity:** low · **Found:** 2026-09-13, fixing B-108 · **Test:** none
(not reproduced in the app; from reading `editor/invert.ts`)

`/template` into an empty bullet writes the template's first-block properties onto that bullet,
and since B-108 the whole insertion is one editor undo step. The inverse of a `block.prop` is
computed from the editor's `EditableBlock`, which models only the reserved keys (`marker`,
`priority`, `collapsed`, `scheduled`, `deadline`, `repeat`, `done`); any other key inverts to
`null` (`invert.ts#propValueBefore`). So if the empty bullet already had `type:: a` (set through
the API, for one) and the template sets `type:: b`, Cmd/Ctrl+Z removes `type` instead of restoring
`a`. Fix when it matters: let an `OpBatch` carry the before-values of the properties it overwrites
(`data/templates.ts` would read them from `block_prop` while it builds the batch), or project
generic properties into the page tree, which today (`BlockRow`) has none.

---

### B-192 · A block's text rewritten elsewhere while you edit it stays stale, and your next keystroke reverts it
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, fixing B-88 (probe below) ·
**Test:** none for the editor itself (the probe was a throwaway spec; its steps are here)

Put the caret in a block. Something else rewrites that block's text — another device, an agent's
`block_update`, or this app's own "Turn into page" (server op `block.to_page`, which turns the
text into `[[First line]]`). The rows around it update after the pull; the block being edited
keeps showing its old text. Type one character: the old text plus the character is written back
over the rewrite, last-writer-wins. Probe (2026-09-13, "Turn into page" with its end-editing step
removed): the server had `[[Probe kickoff]]`; after typing ` typed` it had `Probe kickoff typed`.

Cause: `BlockTree`'s tree effect always prefers the live CM6 buffer for the block being edited,
because a refetch that read before one of this tab's own writes looks the same as an external
change (the B-66 note in that effect). `surface.replaceContent` exists for external changes but is
only called for this tab's own undo/redo/merge. "Turn into page" keeps ending editing before its
op (`commands/registrations/refactor.ts#leaveEditing`) for this reason; there is no guard for the
other writers. A fix needs a way to tell a stale read from a newer write — the block's
`content_hlc` against the HLC of the last text op this tab wrote, for one — and a decision on what
to do with unflushed keystrokes when a newer external text arrives (the owner's call: merge,
prefer local, or prefer remote).

---

### B-193 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails here, on the base commit too
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-editor's wider e2e run ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor" (B-72's test)

Cmd/Ctrl+K while editing, Escape: the palette closes, but `.cm-content` is not focused ("inactive")
for the whole 10 s wait. Failed 3 of 3 runs on `m8/impl-editor` (port 6405), and 1 of 1 with
`apps/web` checked out at `da85cfb`, so this branch did not cause it. Not diagnosed. The
coordinator's full run on `a6c2859` did not list it as failing, and nothing under `apps/web` or
`e2e/` changed between `a6c2859` and `da85cfb` — so either it is load- or machine-dependent (the
machine was running a dozen agents' builds and browsers) or that run passed it by chance. Next
step: run the single test on an idle machine; if it still fails, trace focus on Escape
(`e2e/helpers/focus.ts#installFocusTrace`).

Verification pass, same branch and port, later the same day: `views.spec.ts` passed in full (with
parity, popups, autocomplete, journals, a-fresh-journal, tasks, replace, query and phone: 122 of
122), so the failure is intermittent or load-dependent rather than deterministic.

---

### B-194 · Cmd/Ctrl+Z after the edited block left the page reverts it out of sight and unmounts the editor
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (the probe was a throwaway spec; its steps are here)

Caret in "goes", type " typed"; another writer moves "goes" to another page
(`block.move_to_page` through the API). The row leaves and " typed" is written to the block on
the destination page (B-88, as intended). Now click into "keep", End, Cmd/Ctrl+Z: the undo takes
" typed" back on the OTHER page, where nobody sees it, and the editor disappears from "keep" —
`editingRowIndex` is -1, `document.activeElement` is `<body>`, and the next keystrokes go
nowhere. Probe on the branch: destination read back `["already here","goes","child"]`, no row
held the editor, typed "Z" landed nowhere.

Not introduced by B-88's fix: the same probe against `apps/web` at `da85cfb` (where the row stays
until the click into "keep", which flushes the same text transaction) ends identically. B-88's
flush only makes it reachable without that click.

Cause: `EditHistory` keeps transactions for blocks that are no longer in this tree, and
`BlockTree#doUndo`/`doRedo` call `attachEditing(res.focus.id, …)` without checking that the tree
has a row for that id — `editingId` then names a block nothing renders. Fix when it matters: skip
(or drop) history entries whose blocks have left the tree, or keep the editor where it is when the
focus target is absent; which one is the owner's call (should an undo reach a block that left?).

---

### B-195 · "Move to page…" onto the block's own page while editing it leaves an unfocused editor
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (throwaway probe)

Caret in the first block, right-click it, "Move to page…", pick the page it is already on. The
block moves to the end of the page (correct), and its row still holds the editor, but focus is on
`<body>` — the picker took it and nothing gives it back — so typing goes nowhere until a click.
Before B-88's fix removed `leaveEditing` from this command, it ended editing first and left the
block selected with the outliner focused (typing did nothing there either, but nothing looked
editable). The row did not leave the page, so the tree's new end-editing path (B-88) does not run.
Same family as B-193: a picker or palette closing without handing focus back to the editor.
