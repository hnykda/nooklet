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
