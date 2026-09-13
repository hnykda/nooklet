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
