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
- One query for the whole stream (not one per day): the stream renders 14+ days.

## Done (commit hashes)

- (none yet)

## In flight

- Logging bugs (B-94 existing, B-170, B-171) and this file.

## Next steps

1. `data/day-clock.ts` — the local day as a signal (midnight timer capped at 5 min + visibility
   + focus), fake-clock unit test. Wire into `useQueryResults` (B-94) with a test.
2. `data/agenda.ts` (query) + `views/journalAgenda.ts` (pure selection/grouping, unit tests) +
   `views/JournalAgenda.tsx` (component).
3. Hook into `JournalStreamView` (all day sections) and `PageView` (journal pages); stream `today`
   follows the day clock without unmounting a live editor (B-170).
4. e2e `e2e/tests/journal-agenda.spec.ts`; run with journals/tasks/query specs.
5. Real-graph perf check; record numbers here.

## How to resume

`git log --oneline da85cfb..m8/impl-journal`, then this file's Next steps.
