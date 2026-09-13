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

### B-294 (existing)
**Fixed 2026-09-13.** Of the two answers the entry offered, picking a row now replaces up to the
link's `]]`; the autocomplete still opens inside a complete link. Reasons: it is what spec R56
already described (the pick "consumes" a `]]` after the caret), it lets you retarget a link by
typing inside its name and picking another page, and B-203's Alt+Enter-with-the-popup-open path is
unchanged. `commands/autocomplete/trigger.ts#existingRefTailLength` finds the tail — text after the
caret up to and including `]]` (or `))` for `((`), containing no opener, closer or newline — and
`AutocompletePopup.tsx#queryEnd` extends the replaced span through it for page, date, create and
`[[`→block-ref picks. A `[[` typed straight before another link (`[[|[[Other]]`) does not swallow it.
`#tags` are not covered: B-380. **Test:** `e2e/tests/autocomplete-inside-link.spec.ts` — "Enter on
the autocomplete a walk into a complete [[link]] opened keeps one link (B-294)" and "typing inside an
existing link and picking another page replaces the whole link (B-294)" were red before
(`…Target]]!rget]] omega`, `…Other]]Target]] omega`), green after; "a new [[ typed right before an
existing link leaves that link alone (B-294)" guards the boundary (green before and after). Unit:
`AutocompletePopup.test.tsx` "a pick with the caret inside a complete link replaces the whole link
(B-294)" (red with the tail ignored), `trigger.test.ts` "existingRefTailLength" (3).

---

### B-380 · Enter on the `#` autocomplete that walking into an existing `#tag` opened duplicates the tag's tail
**Status:** open (needs owner decision) · **Severity:** low · **Found:** 2026-09-13, fixing B-294 ·
**Test:** none; probe `tools/probes/autocomplete-tag-walk.spec.ts`

`- alpha #WalkTagTarget omega`, Home, ArrowRight ×12 (caret after `#WalkT`): the tag autocomplete
opens; Enter picks `WalkTagTarget` and replaces only `WalkT`, giving `alpha #WalkTagTarget!agTarget
omega` (with `!` typed after). The `[[link]]` form was B-294, fixed by replacing through the link's
`]]`. A tag has no closer, and the probe's second case shows what that costs: `- alpha omega`, `#WalkT`
typed straight before `omega`, Enter → `alpha #WalkTagTarget!omega` today; a "swallow the rest of the
tag" rule (text up to a `TAG_STOP` character, `core/tokens.ts`) would delete `omega` there, and the
two cases look identical to the popup (same text before and after the caret). Options: (a) leave it;
(b) swallow the tail only when the popup was opened by caret movement rather than typing (needs
`CommandLayer` to remember how each trigger opened); (c) do not open the `#` popup when the caret is
inside a word that already follows `#`.

---

### B-295 (existing)
**Fixed 2026-09-13.** The general fix the entry named: a navigation requested from a key or command
ends editing when it is requested, not when the page unmounts. `app/hosts.ts#createNavigationHost`
calls `requestEditingEnd()` (the same signal Cmd/Ctrl+F uses) at the start of `followLink` for page,
tag and block links, `openPage` (palette page rows, Random page) and `openPageByRef` (`nav.openPage`,
agents). Every tree flushes what was typed and detaches the editor, so focus is on `<body>` until the
new page is clicked into — where `cf08d19` left it after the palette form (B-293). Not changed: web
links (they open in another tab and the editor keeps focus), `back`/`forward`/`openJournals`/
`openSearch` (not measured whether keys typed straight after them can land in the block being left)
and `revealBlock` (documented as not changing focus). Where the correct page already showed, nothing
is lost but the caret: keys typed before the new page is clicked into go nowhere. **Test:**
`e2e/tests/follow-link-typing.spec.ts` — "Alt+Enter on a [[link]], then typing at once: nothing lands
in the block being left (B-295)" and the `((block ref))` form; red before (5 of 5 each with
`--repeat-each=5`: `.cm-content` still focused straight after Alt+Enter; one earlier single run of the
`[[link]]` form passed, so the race is timing-dependent), green after (5 of 5 each). Unit:
`app/hosts.test.ts` "nav.followLink ends editing before it leaves the page (B-295)" (4).

---
