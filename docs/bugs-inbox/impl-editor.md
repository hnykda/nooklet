# Bugs inbox — impl-editor (m8)

Entries in `docs/BUGS.md`'s format, to be merged into it by the coordinator. Existing bugs keep
their numbers; new ones take B-190..B-199.

---

### B-108 (existing)
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
`e2e/tests/template-undo.spec.ts` "Cmd/Ctrl+Z takes back a template inserted into an empty bullet,
and redo restores it" and "Cmd/Ctrl+Z takes back a template inserted after a bullet with text,
caret back where it was"; `apps/web/src/editor/external-batch.test.ts`;
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
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, `e2e/tests/refactor.spec.ts` ·
**Test:** being written (`e2e/tests/editor-row-lifecycle.spec.ts`)

Unchanged from `docs/BUGS.md`: the row holding the editor stays on screen, showing the old text,
after its block is moved to another page or deleted elsewhere.

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
