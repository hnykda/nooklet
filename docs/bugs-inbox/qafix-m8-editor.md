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
