# Bug inbox — qafix-m8-editor

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator. Numbers B-340..B-349.

---

### B-340 · Backspace/Delete merge silently drops the merged block's task marker, dates and properties
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q1, `scratchpad/m9/qa-m8-editor/merge2.mjs`, `props.mjs`) · **Test:**
`e2e/tests/merge-keeps-fields.spec.ts` (both tests)

On `- notes here` / `- TODO buy milk` (with `scheduled:: 2026-09-20` and `owner:: dan`), Backspace
at the start of `buy milk` stored `notes herebuy milk`: no TODO, no scheduled date, no `owner`.
Backspace at the start of an empty block that carries `list:: number` and `source:: book` deleted
the block and both properties. Delete at the end of a buffer (pulling the next block in) and
merging a numbered `delta` with `tag:: x` into a plain block lost them the same way. Nothing warns;
only an immediate Cmd+Z brings the data back.

Cause: `editor/commands.ts#mergeWithPrevious`/`#deleteForwardMerge` wrote only `block.text` (the
joined contents) and `block.delete`; nothing else the deleted block held was written anywhere, and
`content === ""` was taken to mean "empty block" even with properties on it.

**Fixed 2026-09-13.** New `editor/merge-fields.ts#carryFields`: the staying block takes every field
it does not set itself (marker, priority, scheduled, deadline, repeat, done, generic properties) as
`block.prop` ops in the same structural commit, so one Cmd+Z undoes the whole merge. Decisions,
recorded in spec R20a: the marker is carried as a marker rather than as the word `TODO` at the join
(Logseq's raw-text merge leaves it as text; here that text would sit on line 1 when the previous
block is empty, and the mirror would write it back as a task — the B-342 mismatch); when both blocks
set the same field to different values the merge is refused and the outliner's toast names the field
and both values (`mergeRefusedMessage`), because keeping either value silently loses the other.
`done` never refuses. The e2e spec was red on `cf08d19` (both tests: TODO/scheduled/owner and
list/source gone; no notice) and green after; unit: `commands.test.ts` "merges keep what the merged
block carried (B-340)" (4 of 6 red before the fix, the other two guard the Enter-then-Backspace
numbered-item flow and shared fields).

---

### B-341 · On a read-only page, clicking a date chip opens the picker and writes or removes the date
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q2, `scratchpad/m9/qa-m8-editor/locked2.mjs`) · **Test:** `e2e/tests/read-only.spec.ts` "a date
chip on a locked page refuses with the notice and never opens the picker (B-341)"

On a page with `read-only:: true` (the Read-only badge showing), clicking the Scheduled chip of
`TODO locked task` opened the date picker; `+10d` Enter rewrote `scheduled:: 2026-09-20` to today+10,
and the picker's Remove deleted the date. No read-only notice appeared — while a click on the task
marker, a drag and Enter on the same page are refused with one (B-234).

Cause: `editor/DateChips.tsx` (impl-dates) and the page lock (impl-small) merged separately; the
chip's click handler opened `blockDatePicker` unconditionally, and nothing passed it the lock.

**Fixed 2026-09-13.** `DateChips` takes `onLocked`; `BlockRowView` sets it on a locked row to its new
`onReadOnlyRefused`, which `BlockTree` wires to the read-only notice — so the chip refuses exactly
the way the marker does. The e2e test was red before the fix (no notice) and green after.

---

### B-342 · A typed `scheduled::` line is stored as text, but the markdown mirror presents it as a real date
**Status:** open (needs owner decision) · **Severity:** medium · **Found:** 2026-09-13, exploratory
QA of M8 editor features (Q3, `scratchpad/m9/qa-m8-editor/typedkey.mjs`, `dates2.mjs`) · **Test:**
none yet; probe `tools/probes/serialize-property-shaped-content.ts`

`- TODO call mom`: Mod+End, Shift+Enter, type `scheduled:: 2026-09-20`, click another row. The block
is stored with content `call mom\nscheduled:: 2026-09-20` and no scheduled date: no chip, not on the
agenda. But `page.read` text and `graph/pages/<name>.md` show `- TODO call mom` / `  scheduled::
2026-09-20`, which is exactly how a real date is written — and re-importing that text produces a real
`scheduled` date. The database, the row and the mirror disagree, and the "lossless" mirror is not.
A block that also has a real date gets both lines.

What the probe shows (2026-09-13, `pnpm exec tsx tools/probes/serialize-property-shaped-content.ts`):
this is not specific to dates. Every content line shaped like a property or a Logseq timestamp is
written verbatim and read back by shape — `scheduled:: …`, `deadline:: …`, `SCHEDULED: <…>`,
`foo:: bar`, `marker:: DONE` all came back as properties, content `call mom`, `lossless=false`.
Since B-101 a typed generic `foo:: bar` line becomes a real property, so the editor no longer
produces that one; the reserved keys (`scheduled deadline repeat done marker priority collapsed id`),
`heading::` and `SCHEDULED:`/`DEADLINE:` lines still stay text by design (OUT-22a, B-101), and older
content or an API write can hold any of them.

Why not fixed here: both ways out change a documented contract, and they are the owner's call.
1. The editor makes a typed reserved line real when the edit ends and its value is valid (ADR 011
   form): the row, agenda and mirror then agree with what the text says. Costs: OUT-22a's reason for
   keeping them text (half-typed dates) moves to "only on blur / only when valid"; a typed date line
   vanishes from the buffer into a chip; deleting that line afterwards must not be read as "remove
   the date" (the buffer never shows reserved keys). Does nothing for older content or
   `SCHEDULED:` lines.
2. The serializer escapes a content line that would re-read as a property or timestamp (an OUT-13
   style `\` rule, e.g. `scheduled\:: 2026-09-20`) and the parser un-escapes it. Makes the mirror
   lossless for every shape at once; the typed line stays plain text everywhere. Costs: a grammar
   addition in `core/outline.ts` (parse and serialize) that every reader of the mirror, `block.update`
   `old_str` matching, and a Logseq round trip would see.

---

### B-343 · After `/image` or an image paste the caret stays before the inserted image markdown
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q4, `scratchpad/m9/qa-m8-editor/misc2.mjs`) · **Test:** `e2e/tests/image-insert.spec.ts`, both
tests (they now type after the insert)

`- image here`, End, ` /image`, Enter, pick a PNG, wait for the upload, type `Z`: the block became
`image here Z![](assets/….png)`. The upload and the image itself are fine; the caret was left just
before the image, so whatever is typed next lands in front of it instead of after it (the way
`/mermaid` and every other editor places the caret).

Cause: `BlockTree.tsx#insertUploadedImage` dispatched the insertion with no `selection`, and CM6
maps a cursor that sits exactly at an insertion point to before the inserted text.

**Fixed 2026-09-13.** The dispatch sets `selection: {anchor: head + markdown.length}`. Both e2e tests
were red before (`look  Z![](assets/….png)`, `pasted  Z![](…)`) and green after. The other branch of
that function (the editor has moved to another block; the text is written into the old block's
content) has no caret to place and is unchanged.

---

### B-344 · `/mermaid` at the end of existing text puts the fence inline, and the diagram never renders
**Status:** open (feature gap) · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8
editor features (Q5, `scratchpad/m9/qa-m8-editor/misc2.mjs`) · **Test:** none yet

`- after text`, End, ` /mermaid`, Enter, leave the block: the stored content is `after text` followed
on the same line by the starter fence (```` ```mermaid ````, `graph TD`, `A --> B`, closing fence), the
row shows the raw text, and there is no `svg`. The same command on an empty block renders one
diagram.

Why this is not fixed by the obvious one-liner: `plugins/mermaid/src/client.ts` could put the starter
on its own line, but a fence only renders when it is line 1 of a block's content —
`core/tokens.ts#classifyFence` looks at the first line only. Checked with `classifyBlockContent`
(2026-09-13, `tsx -e`): `"after text ```mermaid…"` → `paragraph`, `"after text\n```mermaid…"` →
`paragraph`, `"```mermaid…"` → `fence`. So the diagram can only render if `/mermaid` on a non-empty
block puts the starter into a NEW block after it (or the renderer learns to draw a fence below a
paragraph, which is a grammar change, spec §2.7). The plugin cannot do the first today: it only sees
`editor.insertText`, and the client plugin host throws "not supported" for `editor.currentBlock`,
`editor.insertBlockAfter` and `editor.focusBlock` (ADR 023 list in `api-and-plugin-types.md` §5);
`EditorHost` has no "new block after the current one" operation a host implementation could call.
Needs one of: those three plugin-host methods, a block-level option on `insertText`, or mixed
paragraph+fence rendering. Skipped here as a feature gap.

---

### B-345 · "Set scheduled date" with several blocks selected dates only the first one
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q6, `scratchpad/m9/qa-m8-editor/final.mjs`) · **Test:** `e2e/tests/dates.spec.ts` "with several
blocks selected the date commands are not offered, since they date one block (B-345)"

`- TODO m1` / `- TODO m2` / `- TODO m3`: click m1, Escape, Shift+ArrowDown (two rows selected),
Cmd+K, "Set scheduled date", `tomorrow`, Enter. Only m1 got `scheduled::`; m2 stayed selected with no
date, and nothing said that only one block would be dated. "Set deadline date" is the same command
shape.

Cause: both commands were enabled for `editorFocused || blockSelected` and open one picker for
`targetBlockId(ctx)` — the first selected id (R38 speaks of "the selected block's row", singular).

**Fixed 2026-09-13.** The smaller of the two fixes QA offered: `task.setScheduled`/`task.setDeadline`
are gated on `editorFocused || (blockSelected && selectionCount == 1)`, like `task.cycle`, so a
multi-selection is not offered them (spec table and R38 updated). Dating every selected block would
need a picker with no single starting date and a multi-block write; not done. The e2e test was red
on the old `when` (the palette listed "Set scheduled date" for two selected blocks) and green after;
unit: `commands/registrations/index.test.ts` "the date commands date one block (B-345)" (2/2 red
before).

---

### B-346 · The marker commands (Mark TODO/DOING/DONE/…, Clear marker) act on one block of a multi-selection
**Status:** open · **Severity:** low · **Found:** 2026-09-13, reading `commands/registrations/task.ts`
while fixing B-345 · **Test:** none yet

Same shape as B-345, inferred from the code and not reproduced in a browser: `setMarker`,
`task.setMarkerDone` and `task.clearMarker` are enabled for `editorFocused || blockSelected` and act
on `targetBlockId(ctx)`, which is `selectedBlockIds[0]`. With three blocks selected, "Mark TODO"
should therefore mark only the first. Not fixed with B-345 because the right answer is less clear
here: marking every selected block is a plausible and useful meaning (Logseq cycles the marker of
every selected block on Cmd+Enter — from memory, not checked), where a date picker opened for several
blocks has no single date to start from. Owner decision: gate on `selectionCount == 1` like
`task.cycle`, or apply to all.

---

### B-347 · With blocks selected, Backspace or Delete typed in the command palette deletes the selected blocks
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, writing the B-345 e2e test (its
`fill("")` on the palette input deleted two selected blocks) · **Test:**
`e2e/tests/palette-text-keys.spec.ts`; probe `tools/probes/palette-keys-delete-selection.spec.ts`

Select two blocks (Escape, Shift+ArrowDown), Cmd/Ctrl+K, type `abc`, press Backspace to fix a typo:
the two selected blocks are deleted — on the server too — and the palette input still reads `abc`.
Delete does the same. Probe output: `PROBE Backspace: rows=1 input="abc" stored=["p three"]`, same
for Delete. Anyone correcting a palette query while blocks are selected loses those blocks, and the
palette covers the page, so they may not see it happen.

Likely cause (read, not traced): `app/CommandLayer.tsx#KeyboardDispatch` runs every keydown on
`document` in the capture phase through `keymap/dispatch.ts`, whose context still says
`blockSelected` while the palette is open; `block.deleteSelected` (Backspace, and Delete as a
secondary binding) matches and preventDefaults before the input sees the key. The date picker
avoids this by claiming keys itself (B-145); the palette does not. Other text inputs over a standing
selection (page title, search, page properties) probably behave the same — not probed.

A second probe with eight keys in the palette over a two-block selection (2026-09-13, run once, not
kept): Backspace and Delete deleted both blocks; Cmd+A selected all three blocks instead of the query
text; Tab/Shift+Tab moved focus out of the input; Enter closed the palette and cleared the
selection; Shift+ArrowUp and Cmd+Z changed nothing visible.

**Fixed 2026-09-13** (outside the QA list: found while fixing B-345, fixed because it loses data).
New `app/text-field-keys.ts#textFieldOwnsKey`: a text-editing key — Backspace, Delete, arrows,
Home/End/PageUp/PageDown with any modifier (except Alt+Left/Right outside macOS, Back/Forward), and
Mod+A/C/X/V/Z — whose target is a text field other than the block editor (`.cm-editor`) is left to
the field; `CommandLayer`'s global keydown listener returns before dispatch. Escape, Enter, Tab and
the global shortcuts still dispatch from text fields. Spec: R12a. The e2e test was red before the
hookup (`Backspace` left the input at `abcd`) and green after; it also checks Cmd/Ctrl+A selects the
query and that Backspace with the palette closed still deletes the selection. Unit:
`app/text-field-keys.test.ts`. Behaviour change to know about: Cmd/Ctrl+Z inside a plain text field
(palette, page title, search) is now the field's own undo instead of the outliner's (`edit.undo` is
`when: true`); the undo/redo, template-undo, redo and focus specs still pass, and that a field's
native undo now works was not checked. Tab and Enter in the palette over a selection behave as
before (not data loss; not changed here).
