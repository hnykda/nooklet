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

Not fixed on this branch — every candidate touches how the whole command system decides what a
key means, and each has a cost that needs a decision:

- End a standing selection on a pointerdown outside the outliner (as editing already ends): covers
  the click into the title, not keyboard focus moving there (Tab), and a dialog opened FROM the
  selection (Move to page…) must keep it.
- Report `blockSelected: false` while a text input outside the outliner has focus: also hides the
  selection commands from the palette, whose own input has focus when it asks.
- Have `KeyboardDispatch` leave keys alone whose target is an `input`/`textarea`/contenteditable
  outside the outliner: the most general, in `app/CommandLayer.tsx`, and needs checking against
  every command that is meant to work from such a field.

**Also the command palette, measured 2026-09-13 (verify pass).** The same dispatch reaches the
palette's own input, which is where this bites hardest: Escape out of an edit (a selection now
stands), Cmd+K, type `abc`, Backspace — the palette still reads `abc` and the selected block is
DELETED on the server (throwaway spec, stored `["two","three"]` from `one/two/three`). Cmd+A there
runs `block.selectAll` on the page behind the palette, and Cmd+X then cuts every block of the page
(stored `[]`, clipboard `- one\n- two\n`). Backspace predates this branch; Cmd+X's part is new with
B-245. Suggest raising B-300 to high: the palette is opened from a selection all the time. Not
seen: a selection standing in one journal day does not capture Cmd+X in a block being edited in
another day — the editing tree's context wins and the text is cut natively (checked the same way).

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

**Fixed 2026-09-13** — the cheapest safe mitigation; the options and what is still open are in
`docs/proposals/002-pending-edits-durability.md`. New `apps/web/src/db/unapplied-ops.ts`:
`db/client.ts#applyOps` writes each batch to `localStorage` synchronously before posting it and
removes it when the worker answers (kept if the call fails). At `initDb`, batches of page loads
that are gone — each load holds a Web Lock named after itself, released by the browser with the
document — are replayed through a new worker method, `WorkerDb.replayLocalOps`, which skips op ids
already in the replica's `op` table (so a batch that did land is not pushed again) and otherwise
runs `applyLocal`; a second pass runs 5 s later in case the old document's lock was released late.
A batch whose replay fails is kept for the next start. Tests: `e2e/tests/reload-durability.spec.ts`
"an edit queued behind a busy replica survives a reload after the text debounce (B-247)" and
"... inside the text debounce (B-247)" — 15/15 runs green with the fix (`--repeat-each=5`), and
4/4 red with only the `localStorage` write disabled (B-301's fix still in), so the copy is what
fixes them. Unit: `apps/web/src/db/unapplied-ops.test.ts` (record/settle, only dead owners' batches,
order, quota, unreadable entries, replay keeps a failed batch), `db/client-unapplied.test.ts` (the
copy exists synchronously before the worker answers; `initDb` replays an orphaned batch and removes
it), `db/worker-core.test.ts` "applies and queues ops the replica never saw, and skips ones it
already recorded". Chromium only: WebKit/WKWebView and Capacitor are unverified (proposal §4). Not
covered: a renderer crash inside the editor's 500 ms text debounce, where no `pagehide` runs.

Re-measured on the real-graph copy with the fixed build: reloads 0, 100, 300, 700 and 1,500 ms
after typing all kept the text in the replica AND on the server, without a further edit (before:
100 and 300 ms lost it, 0 and 700 ms left it unpushed). `pnpm nooklet verify` on that copy
afterwards: OK, 20,466 ops replayed, rebuild matches live state.

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

**Fixed 2026-09-13.** `SyncClient.connectLive` schedules an immediate push when `pending_op` is not
empty — once when called at startup (even if the socket never opens) and on every live-socket
`onOpen`, so an outbox that failed to push while the server was down also goes out on reconnect
instead of waiting for the next write. Tests: `e2e/tests/reload-durability.spec.ts` "an edit
written just before a reload is pushed after it, with no further edit (B-301)" (red before, green
after); `apps/web/src/sync/sync-client.test.ts` "pushes ops left in pending_op by an earlier
session as soon as it connects" and "pushes again when live sync reconnects after a failed push"
(both red with the change reverted), "does not push at all when the outbox is empty".

---

### B-302 · Typing into a mid-sized page keeps the DB worker busy for most of a second at a time

**Status:** needs-repro (measured on a loaded machine) · **Severity:** medium (every write waits
behind it to become durable — B-247's window — and every read the UI makes waits too) · **Found:**
2026-09-13, clipboard-sync, `tools/probes/replica-busy-window.mjs` · **Test:** —

On a copy of the real graph, typing ` probe typing words` (60 ms between keys) into the first block
of `Megapage` (201 blocks) and waiting 1.5 s: the worker's event loop was blocked in stretches of
127 ms (1 run), then 250–1,602 ms adding up to 3,175 ms and 2,334 ms (2 runs) — load average between
20 and 70 from other agents at the time, so how much of that is this machine is unknown. Not
investigated: which queries the text flushes trigger (each `applyLocal` fires a change event that
page views, references and the sync status re-query on).

---

### B-303 · Ending an edit shows the block's last-fetched text until the write comes back, and a Cut in that window copies the old text

**Status:** open · **Severity:** high since B-245 (Cut deletes the block and puts the OLD text on
the clipboard: paste it elsewhere and the words just typed are gone; undo restores them, if you
notice) · **Found:** 2026-09-13, adversarial verify of `m9/clipboard-sync` ·
**Test:** `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X straight after typing cuts the text as typed,
while the replica is still busy (B-303)"

Type into a block and, within the 500 ms text debounce, press Escape (or Shift+Down) and Cmd+C /
Cmd+X. Measured with a throwaway spec (MutationObserver on the first row, no artificial load):
the row reads `one typed` while editing, flips to `one` the moment editing ends, and back to
`one typed` 12–20 ms later; Cmd+C at gaps of 0, 100 and 300 ms after the last keystroke copied
`- one` (4 of 4 for Escape, 4 of 4 for Shift+Down), at 700 ms (debounce already flushed) `- one
typed`. Cmd+X in the same window put `- one\n- two\n` on the clipboard and deleted both blocks; the
undo brought back `one typed`, so the replica had the text and only the clipboard lost it. With the
worker busy (1.5 s loop, as on the real graph — B-302 measured 0.1–1.6 s stretches while typing),
the old text stays on screen for the whole stretch.

Cause: `BlockTree.tsx`'s tree effect reads `editingId()` tracked, so ending an edit re-runs it
against the page tree fetched BEFORE `flushPendingEdit`'s write; without the editing overlay, that
stale read replaces the optimistic text in `localBlocks` until the refetch after the write lands.
`selectionMarkdown` reads that tree. Copy (B-84) had the same stale window but no loss.

**Fixed 2026-09-13 (verify pass).** `BlockTree.tsx` keeps the buffer of each flushed text write
until the worker answers it (`unansweredText`) and lays it over whatever page tree the effect
re-runs with; the worker answers in message order, so a tree that resolves after the answer was
read after the write and needs no overlay. A later local op on the block other than a move (undo,
redo, merge, delete) drops the entry. Test: `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X straight
after typing cuts the text as typed, while the replica is still busy (B-303)" — red before the fix
(the selected row itself read `jedna`, not `jedna – přidáno`), green after; it also checks the
property line reaches the clipboard and that one undo brings the typed text back on the server.
Not covered: the effect re-running between the answer and the refetch that follows it (one query
round trip) still shows the old text — only if editing changes in exactly that window.

Real graph (copy, 952 pages; `tools/probes/cut-just-typed.mjs`, no artificial load): on
`Megapage` (201 rows), type into row 2, Escape, Cmd+X 0 / 150 / 350 ms after the last key — the
pre-fix build put the OLD text on the clipboard all three times while the cut removed the block;
the fixed build put the typed text there all three times (and on `2026-05-03`), and one undo
restored the block with it each time. `nooklet verify` on the copy afterwards: OK, 20,485 ops.
