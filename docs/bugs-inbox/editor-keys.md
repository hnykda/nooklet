# Bug inbox — editor-keys (M10)

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator. New numbers B-380..B-389.

---

### B-282 (existing)
**Fixed 2026-09-13.** `commands/registrations/task.ts` runs the task commands (`task.cycle`,
`task.toggleDone`, the six marker commands) through one queue (`createSerialRun`), so a second
Cmd/Ctrl+Enter starts only after the first has committed. That is enough, without reading the marker
from the editor tree: the tree's `commit` posts the write to the DB worker (`void applyOps`)
synchronously, before the queued command posts its `getBlockTaskState` query, and the worker's
`applyLocalOps` is synchronous, so the query sees the write. **Test:** `e2e/tests/task-marker-keys.spec.ts`
"Cmd/Ctrl+Enter pressed twice with no pause cycles the marker twice (B-282)" — red before (row stayed
`TODO`), green after, 4 of 4 with `--repeat-each=4`; it also presses twice from DOING (the R35
completion path) and takes four undo steps back. Unit: `commands/registrations/index.test.ts` "two
task.cycle runs started together advance the marker twice" (red with the queue removed) and "a cycle
queued behind one that throws still runs". Still unmeasured: a slower replica (a busy worker) does
not change the order, so it should not matter, but only a normal machine was tried.

---

### B-346 (existing)
**Fixed 2026-09-13.** Owner decision relayed by the M10 coordinator: act on all selected blocks, as
one undo step. `task.setMarkerTodo/Doing/Waiting/Canceled` write `marker` on every selected block
(or the edited block), `task.setMarkerDone` computes R35's completion per block from its own dates,
and `task.clearMarker` clears every selected block that has a marker — each as ONE write through the
new `Store.setPropsOfBlocks` (`app/hosts.ts`), which commits one op batch anchored on the first block,
so the tree records one history step. `task.clearMarker`'s `when` became `isTask || blockSelected`:
the context snapshot reads `isTask` from the edited block only, so a selection had never been offered
"Clear task marker" at all (spec table and R39 updated). `editor/external-batch.ts` now refuses a
batch that writes a block the tree does not show, since its inverse would read no old value and undo
would write `null` over a real marker. `task.cycle` stays gated on one selected block (spec note 9).
**Test:** `e2e/tests/task-marker-keys.spec.ts` "the marker commands act on every selected block, as
one undo step (B-346)" — red before (only the first of three got TODO), green after; unit:
`commands/registrations/index.test.ts` "the marker commands act on every selected block, in one write
(B-346)" (5 tests), `app/hosts.test.ts` "several blocks' properties go as ONE batch",
`editor/external-batch.test.ts` "refuses a batch that writes a block this tree does not show".
Note: the coordinator's brief said "like Set scheduled date now does (B-345)", but B-345 was fixed the
other way — the date commands are not offered for several blocks — and that is unchanged here.

---
