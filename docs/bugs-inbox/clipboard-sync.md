# Bug inbox — m9/clipboard-sync

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on one file. New
numbers from B-300..B-309 only.

---

### B-233 (existing)

**Cause, found 2026-09-13 (clipboard-sync).** Not a product bug, and not simply "a-fresh-journal
leaves two blocks". Whether it leaves ANY depends on a race: its two blocks are applied to the
browser context's own OPFS replica and pushed to the server after a 300 ms debounce, and the test
ends (context closed, replica thrown away) right after its last local assertion. Measured on
`cf08d19` with a throwaway spec between the two that read `page.read <today>` from the server:
3 runs out of 3, the server had **no** page for today at all, and `editing.spec.ts` passed 5/5 —
its `openJournal` found a virtual day and seeded exactly one block. When the push does land first
(a loaded machine, as on the day it was found), today already has two blocks and "Enter creates a
second bullet" counts 3 rows, because it asserted an absolute count of 2 against a journal every
spec shares. Deterministic reproduction: seed `- first thought\n- second thought` into today via
`page.append` from a spec that runs before `editing.spec.ts` → "Expected: 2, Received: 3".

**Fixed 2026-09-13.** The test was wrong, not the product: Enter on the first of N journal blocks
correctly adds one row. `editing.spec.ts` "Enter creates a second bullet and both keep their text"
now counts the rows it starts with and expects one more, and `a-fresh-journal.spec.ts` "Enter on a
brand-new journal day continues into the next bullet" waits until the server holds its two blocks,
so the journal every later spec sees is the same on every run instead of depending on a push
debounce. Verified: with the seeded two-block today, the old assertion fails (3 ≠ 2) and the new
one passes; `a-fresh-journal` + `editing` together passed 3 runs of 3 after the change. The test
that would have caught it is the seeded run above; it is not kept as a spec because it only
exists to prove the assertion was state-dependent.

In one of those runs, `editing.spec.ts` "typing immediately after Enter is not discarded" failed
once after the reload (1 row, expected 2: the new block and its text both gone) and passed on the
two reruns — plausibly the loss mechanism of B-247 (not verified at this point), not this bug; see there.

---

### B-245 (existing)

Taken on 2026-09-13 (clipboard-sync). Plan as the entry proposed: `block.cutSelection` =
`block.copySelection`'s text on the clipboard, then `block.deleteSelected`'s ops, recorded as one
undo step; a spec row before the code.

**Fixed 2026-09-13.** `block.cutSelection` (Cmd+X / Ctrl+X, `blockSelected`) — spec row in §E and
a paragraph in R31 of `docs/spec/commands-and-keymap.md`. The copy text now comes from one function,
`editor/selection-clipboard.ts#selectionMarkdown`, which both Copy and Cut call (moved out of
`BlockTree.tsx` unchanged, plus a guard for an id no longer in the tree). The cut writes that text,
and only once the clipboard write has resolved builds `deleteSelectedBlocks` against the tree as it
is then and commits it as ONE history entry (`cutToClipboard`): with no `navigator.clipboard` (plain
http from another machine is not a secure context) or a refused write, nothing is deleted. Like
Copy, it is reached through the command registry's key binding, not `keydown.ts#resolveCommand`
(spec §E note 11). Tests: `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X cuts the selection as markdown,
and one undo brings it all back (B-245)" — clipboard text, rows gone from the page and from the
server, one Cmd+Z restores all three blocks with the child still indented, on the server too; it
fails with the registration removed (clipboard stays "sentinel"). Unit:
`apps/web/src/editor/selection-clipboard.test.ts` (subtree written once, reading order, properties
kept, delete only after the write resolved, nothing deleted with no clipboard or a refused write).

Not done: no "Cut" entry in the block context menu (`app/BlockContextMenu.tsx` lists Delete but not
Copy either); `docs/wiki/pages/Keyboard shortcuts.md` is generated and was not regenerated here —
run `node docs/wiki/tools/generate-shortcuts.mjs` after merging.

---

### B-300 · With a block selection standing, Backspace in the page title deletes the selected block

**Status:** open · **Severity:** medium (a destructive key goes to blocks the user is not looking
at; undo restores them) · **Found:** 2026-09-13, clipboard-sync, while checking where the new
Cmd+X can fire · **Test:** — (probe: see below)

Select a block (Escape), click into the page title, press End, Shift+Home, Backspace. Expected: the
title's text is selected and deleted. Seen: the title is unchanged and the selected BLOCK is
deleted — on the server too. The same with Cmd+X since B-245 (the block is cut). The selection
survives the click (still 1 `.vr-row-selected`, `document.activeElement` is the title input), and
the global keydown dispatcher (`app/CommandLayer.tsx#KeyboardDispatch`, capture phase, no check of
the event target) matches `block.deleteSelected` on `blockSelected` before the input sees the key.
Measured with a throwaway Playwright spec on `m9/clipboard-sync` (Backspace: stored `["two"]`,
title unchanged; Meta+x: the same). Only a pointerdown while EDITING ends the session
(`BlockTree.tsx`'s capture-phase listener); a standing selection has no equivalent.

### B-247 (existing)

**Measured 2026-09-13 (clipboard-sync)** with `tools/probes/replica-busy-window.mjs` against a copy
of the real graph (952 pages, 18.6k blocks), Chromium, on a machine shared with a dozen agents (so
two runs differ). The loss window is the DB worker's event-loop lag — a heartbeat inside the worker
records every gap over 50 ms:

| phase | longest gap | total blocked |
|---|---|---|
| cold first load (fresh OPFS, bootstrap) | 1,835 / 2,070 ms | 2,081 / 2,659 ms |
| warm reload | 222 / 271 ms | 343 / 419 ms |
| plain typing, 201-block page | 127 / 1,602 ms | 127 / 3,175 ms |
| `[[proj` popup search | 388 / 763 ms | 637 / 1,460 ms |

End to end, **with no artificial load**, typing ` kept` into a fresh small page and reloading N ms
later (reloaded page's text = the replica; server read 3 s later): 0 ms → replica `x kept`, server
`x`; **100 ms → `x`, 300 ms → `x`** (the edit is gone from the replica, not merely unpushed); 700 ms
→ replica `x kept`, server `x`; 1,500 ms → both `x kept`. So the pagehide flush is not a reliable
hand-off even to an idle worker: its message is posted while the document unloads, and whether the
worker runs it before it is torn down is a race the page right after a load (the worker still
answering that load's queries) loses. The second half of what the probe shows — an op durable in
the replica that the server never gets — is B-301.

Also seen in the existing suite: `editing.spec.ts` "typing immediately after Enter is not
discarded" failed once (after its reload, 1 row instead of 2) — consistent with this mechanism, not
proven to be it.

Test before the fix: `e2e/tests/reload-durability.spec.ts` "an edit queued behind a busy replica
survives a reload after the text debounce (B-247)" and "... inside the text debounce (B-247)" — both
fail on `cf08d19` + B-233/B-245 (server keeps `x`).

---

### B-301 · An edit written just before a reload never reaches the server until something else is edited

**Status:** open · **Severity:** high (a device can hold an edit the server never gets; closing the
tab and continuing on another device loses it there) · **Found:** 2026-09-13, clipboard-sync,
measuring B-247 · **Test:** `e2e/tests/reload-durability.spec.ts` "an edit written just before a
reload is pushed after it, with no further edit (B-301)"

Type into a block, reload between ~0.5 s and ~0.8 s later (after the 500 ms text debounce handed the
op to the worker, before the 300 ms push debounce that follows): the reloaded page shows the text —
it is in the replica's `pending_op` outbox — but the server does not get it, 3 s later or ever,
until a later local write anywhere schedules a push (the probe's "one more edit elsewhere" pushed
it). `WorkerDb.start()` bootstraps, connects the live socket and pulls, and nothing at startup
pushes an outbox left by a previous session; `schedulePush` is only called by `applyLocal` and by
the online/visible/resume lifecycle events.

