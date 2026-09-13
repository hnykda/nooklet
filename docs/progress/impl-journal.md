# M8 progress — impl-journal (journal "Scheduled and deadline" section + B-94)

Updated after every meaningful step. If you are reading this after a restart, continue from
**Next steps**. Branch `m8/impl-journal`, based on `da85cfb`. e2e port 6403.

## Task

1. Audit §2 item 1 (`docs/review/2026-09-12-exposure-audit.md`): the "Scheduled and deadline"
   section PLAN §8 promises. Today: tasks scheduled/due today + overdue (not DONE/CANCELED);
   other days: tasks scheduled/due that day. Read-only, under the day's blocks, grouped by page,
   click navigates, hidden when empty, read from the client replica. Check the stream stays fast
   on a real-graph copy.
2. B-94: re-evaluate a query fence at local midnight and on visibility change; fake-clock test.

## Decisions

- **Tasks only** (open markers TODO/DOING/LATER/NOW/WAITING), not every block carrying a date.
  The brief and the audit say tasks; PLAN §8 says "blocks" and Logseq also lists marker-less
  dated blocks. Reason: a marker-less block can never be completed, so as "overdue" it would sit
  on today's journal forever; and open tasks with a date are one range scan of the existing
  partial index `block_open_tasks(due_day, id)`. The owner's graph has 0 marker-less dated blocks
  (checked 2026-09-13 on a copy), so nothing real is hidden. The owner may want marker-less dated
  blocks on their exact day — a small change in the SQL; flagged to the coordinator.
- Both columns are matched: a task scheduled on D1 with a deadline on D2 appears on both days
  (`due_day` alone would hide the deadline — B-171).
- Overdue = an open task whose scheduled or deadline day is before today.
- A task living on the day's own journal page is not repeated in that day's section — it is
  already on screen directly above.
- The section also shows on a date route whose journal page does not exist yet
  (`/page/2026-09-22` → "doesn't exist yet" + what is scheduled then): that is where a date link
  to an upcoming day lands, and the stream never shows a future day without a page.
- Read-only rows show the marker glyph, priority, rendered content and a date chip ("Scheduled",
  "Deadline 17:00"; an overdue chip names its date in the reader's journal title format).
- One query for the whole stream (not one per day): the stream renders 14+ days.

## Done (commit hashes)

- `docs(progress): impl-journal — plan, decisions; log B-94 (existing), B-170, B-171`.
- `fix(web): a query fence re-evaluates today at local midnight (B-94)` — `data/day-clock.ts`
  (+ `day-clock.test.ts`, 7 tests), `data/queries.ts` source carries `today`,
  `data/queries.today.test.ts` (2 tests, both fail on the old `queries.ts`). Web unit suite:
  691 passed / 2 failed on the first run — `page-title.test.ts` timed out at 5 s on a cold import
  (load average 45; passes alone with `--testTimeout=60000`), `render-seams.test.tsx` (a 1 s `waitFor`
  on a lazily loaded fence view that mocks `useQueryResults`) passed on 3 of 3 reruns. e2e for the fence not yet run (step 4).

- `feat(web): Scheduled and deadline section on journal days; the stream's Today follows the
  local day (B-170)` —
  `data/agenda.ts` (one SQL read of open dated tasks, `useAgendaTasks`) + `agenda.test.ts` (real
  SQLite, 3 tests incl. an EXPLAIN QUERY PLAN guard), `views/agendaDay.ts` (pure rules) +
  `agendaDay.test.ts` (7), `views/JournalAgenda.tsx` + `journal-agenda.css` +
  `JournalAgenda.test.tsx` (5), `views/streamToday.ts` + `streamToday.test.ts` (4),
  hookups in `JournalStreamView.tsx` (every day section: upcoming, today, pinned, earlier) and
  `PageView.tsx` (a whole journal page), `JournalStreamView.test.tsx` +2 tests. Web unit suite
  714/714, `pnpm -r typecheck` exit 0.
- Naming note: the pure module was first `views/journalAgenda.ts` next to `JournalAgenda.tsx`; on
  macOS's case-insensitive disk `./JournalAgenda.js` resolved to the `.ts` file and the component
  import came back `undefined`. Renamed to `agendaDay.ts` before committing.

- `test(e2e): journal agenda spec; the section on a not-yet-written day; log B-172, B-173` —
  `e2e/tests/journal-agenda.spec.ts` (6 tests: today + overdue grouped by page, row/heading
  navigation, another day with no overdue — on its page and in the stream, a day without a page,
  hidden once emptied, live removal after an API write), `PageView.tsx` shows the section on the
  "doesn't exist yet" view of a date route too. `tools/probes/block-update-property-roundtrip.ts`
  (B-172). e2e on port 6403: agenda spec 6/6 alone; with journals, views, tasks, query,
  a-fresh-journal, templates: 68 passed, 1 failed — `views.spec.ts:461` palette focus, which also
  fails on a clean `git archive da85cfb` checkout (B-173), so not this branch.

- `docs(bugs): log B-174` — found by the perf probe's typing step: on a clean `da85cfb` build
  against the owner's graph, one typed character in an earlier stream day replaced 28 of 29 day
  sections and the editor with them.
- `fix(web): journal-stream sections are keyed by day, so editing an earlier day survives its own
  write (B-174)` — `JournalStreamView.tsx` iterates day numbers; `JournalStreamView.test.tsx` +1
  (fails on the old view: 13 mounts vs 4); `e2e/tests/journal-stream-editing.spec.ts` (fails on
  base, passes here). Web unit 715/715; typecheck exit 0; e2e on 6403: journal-agenda,
  journal-stream-editing, journals, a-fresh-journal, templates, phone, focus, editing — 59 passed;
  views, query, tasks — 49 passed, 1 failed (`views.spec.ts:461`, B-173, fails on base too).

## In flight

- Real-graph perf numbers (step 5).

## Next steps

1. (done) day clock + B-94.
2. (done) agenda data + rules + component.
3. (done) hookups + B-170.
4. (done) e2e.
5. Real-graph perf check with `tools/probes/journal-agenda-perf.mjs`: base build
   (`scratchpad/impl-journal/base`, a `git archive da85cfb` with `apps/web/dist` built by its own
   e2e run) vs this branch, on the real copy and on a stress copy (686 dated open tasks, 386
   overdue — made by SQL on a copy, so `verify` on it is meaningless). One browser profile per
   build per graph (a shared profile's service worker served the other build's bundle). Record
   medians here. Note: the base build cannot run the probe's typing step (B-174 loses the editor),
   so compare load / load-more on base, and edit cost only between variants of this branch.

## How to resume

`git log --oneline da85cfb..m8/impl-journal`, then this file's Next steps.
