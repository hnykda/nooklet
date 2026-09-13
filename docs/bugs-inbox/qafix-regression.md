# Bugs inbox — qafix-regression (M10 final regression pass, Q1-Q5)

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. Numbers B-410..B-419.

---

### B-410 · Typing into a journal day that exists but has no blocks loses the text (the draft's `page.create` is rejected), and an empty page has nowhere to type
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M10 regression pass (Q1) on a copy
of the real graph · **Tests:** `e2e/tests/journal-draft-sync.spec.ts` "today offers no draft until
the first sync says whether today exists, and nothing typed after it is lost (B-243, B-410)";
`e2e/tests/journal-day-start.spec.ts` "a journal day whose blocks were all deleted still has
somewhere to type (B-410)" and "a page an agent created empty has somewhere to type (B-410)";
`apps/web/src/views/JournalStreamView.test.tsx` "offers no draft for today while the stream has not
answered, then the day it answers with (B-410)"

QA gave today's journal blocks, deleted all of them through the API (the page stays, block_count
0), opened `/journals` in a fresh browser, clicked today's draft and typed `first line`, Enter,
`second line`. Nothing was stored: the op log had `page.create 2026-09-13` plus the two
`block.create`s, twice, all `rejected`, and no error anywhere. A variant typing slower stored one
block, `first today lisecond today line`.

Reproduced on this branch's base with a probe (scratch `q1-probe.mjs`, real-graph copy on port 6481)
that logs the sync requests: the draft rendered at 56 ms, the keys went in at 120 ms, the snapshot
request only started at 146 ms, and the push answered `page-key-collision` for the `page.create` and
`no-such-page` for both blocks. Two different defects were behind the report:

1. **Not the zero blocks — the fresh client.** Every call into the replica worker waits for the
   first sync (by reading: `db.worker.ts#requireDb` resolves only after `WorkerDb.start()`, which
   awaits the snapshot), so on a fresh client the journal stream's resource stays unresolved for
   the whole first sync, ~2 s on the real graph. `JournalStreamView` rendered the draft whenever
   `todayEntry()?.page` was falsy, and an unresolved stream is falsy too. A draft committed then
   (Enter or blur) created a page for a day the server already had, and nothing said so when the
   server refused it. The same draft with no commit was B-243's report. Any existing day did this,
   with or without blocks. QA saw it on an emptied day because that is the day they had just made.
   When the probe gave the client 8 s to sync first, the same day rendered an outline, not the
   draft.
2. **The zero blocks.** Once the replica had the emptied page, the stream rendered its `BlockTree`,
   which has no rows and nothing to click, so there was nowhere to type at all (`rows: []` in the
   probe). The same applies to any page with no blocks: an agent's `page.create` without markdown,
   or a page whose blocks were all deleted in the UI. B-75 fixed only pages created from the UI, by
   creating a first block along with the page.

**Fixed 2026-09-13.** (1) The today section renders a non-interactive `JournalDayLoading` row
(`.vr-draft-loading`) until the stream has answered; the draft appears only for a day the stream
says has no page. A calendar-pinned day already waited, since its section is not rendered until its
resource answers. (2) `BlockTree` renders a "Start typing…" row (`.vr-empty-start`) for an editable
page whose fetch answered with no blocks, when not zoomed or filtered. Clicking it creates an empty
first block through the tree's own commit path (optimistic and undoable) and puts the caret in it.
The e2e tests: the fresh-client one holds `/sync/snapshot` with `page.route` and fails on the base
(the draft is visible); the two empty-page tests fail on the base (no `.vr-empty-start`).

Not covered: a draft committed for a day that another device creates at the same moment, before
this replica has pulled it. Core rejects the second `page.create` by design (sql-schema rule 24,
"two devices created the same page name offline"), and the blocks typed under it go with it. For
journal days that is a sync-design question (e.g. deterministic journal page ids), not a UI fix.
See B-415.

---

### B-411 · On a day started from its draft, text typed in the moments after Enter comes out garbled ("second line" stored as "ecoe")
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M10 regression pass (Q2) on a copy
of the real graph · **Tests:** `e2e/tests/journal-day-start.spec.ts` "text typed 0 ms after Enter
on a calendar-opened day's draft lands intact (B-411)", "typing straight on after Enter while the
replica is busy keeps every key (B-411)", "a day started while the replica is busy from the first
key keeps every line (B-411)" (and the 300 ms variant, which passes on the base too — the small e2e
graph closes that window in time); `apps/web/src/views/VirtualJournalDay.test.tsx` "once focus has
prepared it, Enter writes the day and shows its tree in the same task (B-411)" and "keeps taking
lines while the replica has not answered, and writes them all at once (B-411)";
`apps/web/src/views/JournalDayOutline.test.tsx` "keeps the draft, and the tree it started, when the
stream then reports the day's page (B-411)"

Open a day from the calendar that has no page, type `first line` in its draft, Enter, wait 300 ms,
type `second line`, Enter, `third line` (30 ms per key). QA stored `['first line','ecoe','third
line']` three times out of three; other days and pauses gave `ecne`, `nd hird line` (an Enter lost
as well), or `e`. On today's draft, `TODO call back [[QA10 Al` typed right after Enter was lost.

Measured on the base with a timeline probe (scratch `q2-probe.mjs 25 300 30`, real-graph copy): Enter
at 346 ms removed the draft and mounted the draft's own `BlockTree`, whose editor attached only when
its fetch answered, at 646 ms. Keys in those 300 ms went to `<body>`. At 734 ms the pinned section's
resource saw the page and swapped in a second tree for it (B-107's race), and keys went nowhere again
until B-107's hand-back re-attached an editor at 902 ms: `secine`. Two gaps, then:

1. **Enter to the first editor.** The draft awaited the journal template and an HLC pool (two worker
   round trips), then the write, then the new tree's fetch, before any editor existed.
2. **The swap.** The section rendered the draft only while its entry had no page, so the draft's
   own tree was replaced as soon as the write showed up in the stream.

**Fixed 2026-09-13.**
- `views/JournalDayOutline.tsx` (new) holds a day's slot in the Today and jumped-to sections, keyed
  by day. Once the draft has started the day (`onStarted`), it stays and renders the day's only tree.
- `VirtualJournalDay` fetches the template and HLC pool when the draft gains focus (`prepare`). Enter
  then writes the page, the template and the typed rows, and shows the tree, in one synchronous step.
- The tree is drawn from that batch before its fetch answers (`BlockTree`'s new `initialOps`), so
  the focus request is claimed on mount and the next key already has an editor. Measured after the
  fix, same probe on day 27: Enter at 357 ms, editor focused at 361 ms, stored `first line`,
  `second line`, `third line`.
- If the pool is not ready at Enter (the replica is busy), the textarea stays and keeps the keys:
  Enter closes a line, shown above it. When the worker answers, every line is written and the caret
  goes to the end of the last one.
- The pool is minted before anything the tree writes, so the day's `block.create`s carry the older
  HLCs. A `block.text` older than its `block.create` would lose last-writer-wins.
- B-107's focus hand-back is gone: there is no second tree to hand the caret to.

Re-run on the real-graph copy with this branch's build: QA's `s5.mjs` on days 22 (300 ms), 26
(200 ms), 21 (0 ms), 24 (400 ms) and 20 (250 ms, no key delay) all stored the three lines. QA's `s6.mjs
400 40` on a fresh copy stored both lines, and they were still there after a reload.
QA's `s2-journal.mjs` on a fresh copy stored every line too, but only 2-3 s later. See B-416.

Not covered: a draft committed for a day the replica does not yet know exists (another device wrote
it first) still makes a colliding `page.create` (B-415). The pool's HLCs are minted at focus. A
draft left focused for a long time writes the day with HLCs from then, which is harmless for new
entities but untested.

---

### B-107 (existing)

**Fixed 2026-09-13** (again, by removal): the race it patched, two trees for one journal page
during the draft-to-outline swap, no longer exists. Since B-411 the day's section keeps the draft
and its single tree (`views/JournalDayOutline.tsx`), so the hand-back in `VirtualJournalDay`'s
cleanup is gone along with its two unit tests. They are replaced by
`apps/web/src/views/VirtualJournalDay.test.tsx` "leaves the caret request alone when torn down
after starting the day" and `JournalDayOutline.test.tsx` "keeps the draft, and the tree it
started, when the stream then reports the day's page (B-411)". The e2e case B-107 names,
`templates.spec.ts` "a day started in the app begins with the journal template, the typed text
after it", passes.

---

### B-243 (existing)

**Fixed 2026-09-13** (superseded): the window B-243 patched no longer opens. Since B-410, today
shows a non-interactive loading row until the stream has answered, so a fresh client has no draft to
type into during its first sync. Its e2e test is rewritten to that contract:
`e2e/tests/journal-draft-sync.spec.ts` "today offers no draft until the first sync says whether
today exists, and nothing typed after it is lost (B-243, B-410)". It fails on `70c9bb9`, where the
draft is visible while the snapshot is held. The append-on-teardown path stays for a draft swapped
out because another device wrote the day, and its unit tests still pass.

---

### B-416 · Blocks just made with Enter disappear from the outline for a second or two after Escape while the replica is busy
**Status:** open · **Severity:** low · **Found:** 2026-09-13, re-running QA's `s2-journal.mjs` for
B-411 on a copy of the real graph · **Test:** none; probe `scratchpad/m10/qafix-regression/p3/s2-net2.mjs`
(steps below)

On today's journal, type a line, Enter, `child of todo`, Tab, Enter,
`Czech: příliš žluťoučký kůň #[[QA10 Beta tag]]` at Playwright's default speed, then Escape. For
about 2 s the outline shows only the rows that existed before, and the sync indicator says
`syncing (5)`, then `syncing (6)`. Then the push goes out and the rows come back
(probe timeline: Escape ~2.7 s, rows 2 and stored 2 until 4.8 s, then rows 4 and stored 4). Nothing
is lost: a reload in that window showed every row, and the server had them all. QA's
report that "the Enter/Tab/typing that followed made no blocks" was this state, read 1.5 s after
Escape. The same typing without the `#[[…]]` part pushed within 1 s and the rows never dropped.

Cause, partly by reading: every keystroke inside `[[`/`#[[` runs the popup's search in the replica
worker (B-244 measured a busy worker at seconds on this graph). While those searches are queued,
the tree's writes and refetches wait. Escape ends editing, and `BlockTree`'s tree effect re-runs
against the last fetched tree. `UnseenCreations` keeps only the block being edited, so the other new
rows drop until a fetch that includes them answers. B-303 fixed the same shape for text; creations
are not covered. Not fixed here: it is outside B-411's cause.

---
