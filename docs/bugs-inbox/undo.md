# Bug inbox — m9/undo

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. Every test named here is in
`e2e/tests/undo-gaps.spec.ts` unless it says otherwise.

### B-142 (existing)

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z takes back a date set
with the picker, keeps editing, and redo sets it again (B-142)", "Cmd/Ctrl+Z takes back a date
picked from a chip, with nothing being edited (B-142)", "priority and marker set from the palette
are each one Cmd/Ctrl+Z (B-142)", "typing then Cmd/Ctrl+Enter inside the write debounce:
Cmd/Ctrl+Z takes back the marker first (B-142, B-280)"; `apps/web/src/app/hosts.test.ts` "createStore block-property
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
from the palette or menu, and `task.setPriorityA/B/C`. That includes Cmd/Ctrl+Enter itself, which
the global dispatcher runs as the `task.cycle` command through the store, not through
`BlockTree#runCommand`: it was not undoable on `cf08d19` either (see B-280's second test). `liveEditorHost.commitOps`
(`app/editor-host.ts#commitThroughEditor`) now tries the active tree, then the tree whose session
ended last, then every mounted one (`registerEditorHost`, one line in `BlockTree`), and the tree
that takes the batch becomes the undo target. Without that, a date picked from a chip — nothing
edited or selected, so no active tree — still went past every history. A tree only takes a batch
for a block it shows (`external-batch.ts`), so a write never lands in the wrong page's history.
Cost: the store's write now resolves when the tree has the change, not when the replica does
(the tree does not await `applyOps`, same as every edit). The three e2e tests fail on `cf08d19`
and pass with the change; `dates`, `tasks`, `templates`, `template-undo`, `undo-redo`, `redo` and
`selection` specs stay green (55/55). On a copy of the owner's graph
(`tools/probes/undo-real-graph.spec.ts`): palette priority and Cmd/Ctrl+Enter undone on a
task-heavy page, a chip date undone on journal 2022-12-16; `nooklet verify` OK afterwards.

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

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z after the edited block
left the page neither reaches it nor loses the editor (B-194)"; `apps/web/src/editor/history.test.ts`
"EditHistory — steps on blocks that left the tree are dropped (B-194)" (4);
`apps/web/src/editor/undo-focus.test.ts` (5)

Reproduced on `cf08d19`: after the move, click into "keep", End, Cmd+Z, type "Z" — no
`.cm-content` anywhere (`element(s) not found`).

**Fixed 2026-09-13.** Both halves the entry offered, since they answer different questions:
- *Should an undo reach a block that left?* No. `EditHistory.undo`/`redo` take a `present(id)`
  predicate (`BlockTree#stillInTree`: in the tree, or created here and not yet returned by a
  refetch) and drop, not skip, every step on top whose recipes write to a block that is not present
  and is not revived by the step itself (`history.ts#reachable`) — then apply the next older one.
  Cmd/Ctrl+Z in a page only changes what that page shows; the text typed into "goes" stays on the
  page it was moved to. Dropped rather than kept for later: if the block comes back, an undo
  reaching it then would be a surprise, not an undo.
- *Where does the editor go?* A recorded caret is followed only into a block that has a row
  (`editor/undo-focus.ts#focusAfterStep`), so it can no longer be attached to a block nothing
  renders (also: under a collapsed parent, outside the zoom root, filtered out by find in page).

**Owner's call, flagged:** the entry left "should an undo reach a block that left?" to the owner.
This branch answers no. If the answer should be yes, delete the `present` argument in `doUndo`/
`doRedo` (two call sites); the focus rule stays either way. The e2e test fails on `cf08d19` and
passes with the change.

---

### B-162 (existing)

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "undoing a collapse keeps editing, so
redo collapses it again from the keyboard (B-162)", "undoing Collapse all keeps editing a block that
stayed on screen, and redo folds again (B-162)"; `apps/web/src/editor/undo-focus.test.ts`

Reproduced on `cf08d19` by both: after Cmd+Z the active element is `<body>`.

**Fixed 2026-09-13.** The cause was the one the entry read: `doUndo`/`doRedo` treated a step with
no recorded caret as "detach the surface", and collapse, expand, Collapse all, a keyboard marker
cycle and a command's batch all record none. Rather than record a caret at each of those call
sites, the rule itself changed (`editor/undo-focus.ts#focusAfterStep`, used by the one
`BlockTree#applyHistoryStep` both now share): no caret to follow leaves the editor where it is
while its row is on screen, and ends editing only when the step took that row away (an undone
create, an undone expand folding it back). That covers every null-focus step at once, including
ones nobody listed (Cmd/Ctrl+Enter then Cmd/Ctrl+Z also ended editing). Both e2e tests fail on
`cf08d19` and pass with the change.

---

### B-280 · Typing then collapsing within half a second: Cmd/Ctrl+Z undoes the typing before the collapse
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9/undo (reading `BlockTree#commitOne`
while fixing B-162) · **Tests:** `e2e/tests/undo-gaps.spec.ts` "typing then collapsing inside the
write debounce: Cmd/Ctrl+Z undoes the collapse first (B-280)", "typing then Cmd/Ctrl+Enter inside
the write debounce: Cmd/Ctrl+Z takes back the marker first (B-142, B-280)"

Edit "parent" (it has a child), type " more", press Cmd/Ctrl+Up within 500 ms: the block
collapses. Cmd/Ctrl+Z: the typing goes ("parent"), the block stays collapsed; the second Cmd/Ctrl+Z
expands it. Undo order is the reverse of what was done. The e2e test fails on this branch before
the fix (`Expected: 2, Received: 1` rows after the first Cmd+Z).

Cause: `commitOne` (collapse and expand from the keyboard or the bullet arrow, an image upload
that lands after the editor moved on) and the marker commits (`task.cycle` in `runCommand` and
`runSelectionCommand`, `onToggleMarker`, the marker click) push their step without flushing the
pending text edit first. The keystrokes are recorded later — on the debounce timer, or by the
flush at the start of `doUndo` — so they land ABOVE the step that came after them. Every other
structural path goes through `runStructural`, which flushes first.

**Fixed 2026-09-13.** `BlockTree#commitStep` flushes the pending edit and stops capturing before it
commits, like `runStructural`; `commitOne`, the `task.cycle` case of `runCommand` and
`onToggleMarker` go through it. The collapse test fails before the change and passes after it.
The Cmd/Ctrl+Enter test does not isolate B-280: Cmd/Ctrl+Enter is taken by the global command
dispatcher (document capture phase) and runs `task.cycle` through the command `Store`, which since
B-142 commits through `runStructural` and so already flushed. What it does pin is B-142 for the
keyboard: with the store's editor commit disabled (the `cf08d19` behaviour) it fails —
`Received: "TODO"` after Cmd+Z — so Cmd/Ctrl+Enter was never undoable either.

---

### B-281 · A date picked from a chip in another journal day, with a block still selected in this one: Cmd/Ctrl+Z takes back the wrong thing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying `m9/undo` (probe) ·
**Tests:** `e2e/tests/undo-gaps.spec.ts` "a date picked from a chip in another journal day, with a
block still selected in this one, is what Cmd/Ctrl+Z takes back (B-281)";
`apps/web/src/app/editor-host.test.ts` "taken by another tree while a selection stands in the
active one: that session ends (B-281)"

Journal stream, two days on screen. Click into a block of day A, type " typed", press Escape (the
block stays selected — and stays selected through clicks elsewhere, so its tree stays the active
editor host). Click the deadline chip of a block in day B, pick "+31d". Cmd/Ctrl+Z: the date stays
and " typed" is taken back in day A. The date's step sits in day B's history, where a later
Cmd/Ctrl+Z in day B would take it back by surprise (the B-241 shape). The e2e test fails on
`695af3a` (`deadline` still `+31d` 10 s after Cmd+Z).

Cause: B-142's `commitThroughEditor` lands the batch in the tree that shows the block (day B) and
makes it `recent`, but `historyEditorHost()` prefers `active` — day A, because of its standing
selection. So "the tree that takes the batch becomes the undo target" only held when nothing was
selected anywhere else. With editing (not a selection) in day A the chip's pointerdown already
ends that session, so only the selection case is affected.

**Fixed 2026-09-13.** `app/editor-host.ts#commitThroughEditor`: when a tree other than the active
one takes a batch that does not move the caret, it calls `requestEditingEnd()` — every tree ends
its editing session and drops its block selection, the selected tree withdraws as the active host,
and Cmd/Ctrl+Z reaches the tree that took the step. Cost: the block left selected in day A is no
longer selected after a date is picked in day B (a click into day B leaves it selected, P14 in the
verification probe; that inconsistency predates this branch and is not touched). The e2e test
fails before the change and passes after it, redo included; the unit test fails with the line
removed.
