# Bugs inbox — impl-editor (m8)

Entries in `docs/BUGS.md`'s format, to be merged into it by the coordinator. Existing bugs keep
their numbers; new ones take B-190..B-199.

---

### B-108 (existing)
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) ·
**Test:** being written (`e2e/tests/editor-undo-batches.spec.ts`)

Unchanged from `docs/BUGS.md`: a template inserted with `/template` stays after Cmd/Ctrl+Z.

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
