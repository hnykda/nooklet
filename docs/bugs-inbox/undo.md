# Bug inbox — m9/undo

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. Every test named here is in
`e2e/tests/undo-gaps.spec.ts` unless it says otherwise.

### B-142 (existing)

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z takes back a date set
with the picker, keeps editing, and redo sets it again (B-142)", "Cmd/Ctrl+Z takes back a date
picked from a chip, with nothing being edited (B-142)", "priority and marker set from the palette
are each one Cmd/Ctrl+Z (B-142)"; `apps/web/src/app/hosts.test.ts` "createStore block-property
writes (B-142)" (3); `apps/web/src/app/editor-host.test.ts` "a command's op batch reaches a tree
that shows its block, focused or not (B-142)" (3)

Reproduced on `cf08d19` by all three e2e tests before any change: the picked date stays
(`Received: "2026-09-14"` 10 s after Cmd+Z), the chip's date stays (`2026-09-25`, not the `09-22`
it had), and palette "Set priority A" stays `A`. So the palette marker/priority commands have the
gap too, as the entry guessed by reading.

**Fixed 2026-09-13.** The seam is the command `Store`, not each command: `app/hosts.ts#createStore`
builds every `setBlockProp`/`setBlockProps` write as one `OpBatch` and hands it to
`EditorHost.commitOps` (the method `/template` already used, B-108), falling back to `applyOps`
only when no tree takes it. Every store-routed write is covered at once: the date picker (slash
item, palette row, chip), `task.cycle`/`task.toggleDone`/`task.setMarker*`/`task.clearMarker`
from the palette or menu, and `task.setPriorityA/B/C`. `liveEditorHost.commitOps`
(`app/editor-host.ts#commitThroughEditor`) now tries the active tree, then the tree whose session
ended last, then every mounted one (`registerEditorHost`, one line in `BlockTree`), and the tree
that takes the batch becomes the undo target. Without that, a date picked from a chip — nothing
edited or selected, so no active tree — still went past every history. A tree only takes a batch
for a block it shows (`external-batch.ts`), so a write never lands in the wrong page's history.
Cost: the store's write now resolves when the tree has the change, not when the replica does
(the tree does not await `applyOps`, same as every edit). The three e2e tests fail on `cf08d19`
and pass with the change; `dates`, `tasks`, `templates`, `template-undo`, `undo-redo`, `redo` and
`selection` specs stay green (55/55).

---

### B-191 (existing)

**Status:** fixed · **Test:** `e2e/tests/undo-gaps.spec.ts` "undo of /template into a bullet that
already had the template's property restores the old value (B-191)"

**Fixed 2026-09-13, before this branch, by B-101** (`89c0f22`, merged in `cf08d19`). B-191 was
logged on `m8/impl-editor` from reading `invert.ts`, whose `propValueBefore` inverted every
non-reserved key to `null`. B-101's branch, merged afterwards, projected generic properties into
`EditableBlock.properties` and made `propValueBefore` read `block.properties[key]`, which is the
fix the entry asked for. No code change here: the e2e test above (empty bullet with `kind:: a`,
`/template` whose first block has `kind:: b`, Cmd+Z, server has `kind: a` again and the buffer
shows `kind:: a`) passes on `cf08d19`, and fails when `propValueBefore`'s default case is put back
to `return null` (server `{}` instead of `{ kind: "a" }`) — so it is the test that would have
caught it.

---

### B-194 (existing)

**Status:** in progress · **Test:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z after the edited block
left the page neither reaches it nor loses the editor (B-194)"

Reproduced on `cf08d19`: after the move, click into "keep", End, Cmd+Z, type "Z" — no
`.cm-content` anywhere (`element(s) not found`).

---

### B-162 (existing)

**Status:** in progress · **Test:** `e2e/tests/undo-gaps.spec.ts` "undoing a collapse keeps editing,
so redo collapses it again from the keyboard (B-162)", "undoing Collapse all keeps editing a block
that stayed on screen, and redo folds again (B-162)"

Reproduced on `cf08d19` by both: after Cmd+Z the active element is `<body>`.

---
