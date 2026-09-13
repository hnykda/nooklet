# Bugs inbox — impl-journal (M8)

Entries for `docs/BUGS.md`, written here so a dozen parallel branches do not conflict on it. The
coordinator folds them in. Format matches `docs/BUGS.md`.

---

### B-94 (existing) · A ```query fence keeps yesterday's "today" after midnight until something else changes
**Status:** open · **Severity:** low · **Found:** 2026-09-12 while building the fence · **Test:** —

Unchanged from `docs/BUGS.md`: `useQueryResults` (`data/queries.ts`) re-runs only when
`block`/`block_prop`/`page` change, and `today` is read at evaluation time, so a page with
`scheduled:<=today` left open across midnight lists the previous day's results.

---

### B-170 · The journal stream keeps yesterday as "Today" after midnight
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, impl-journal (reading
`views/JournalStreamView.tsx` while adding the "Scheduled and deadline" section) · **Test:** —

`JournalStreamView` reads `todayJournalDay()` once, when it mounts. A tab left open overnight —
the normal state of a desktop outliner — still shows yesterday under "Today" the next morning, with
no virtual row for the real today; typing lands on yesterday's page. Only navigating away and back
fixes it. Same root cause as B-94 (no signal for "the local day changed"); it matters more once the
day carries a "Scheduled and deadline" list, which would show yesterday's agenda as today's.

---

### B-171 · The Tasks view's due-date window ignores a deadline when the task is also scheduled
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-journal (reading
`views/taskFilters.ts` for reuse) · **Test:** none

`filterTasks`' "Due from / Due to" compares `due_day`, which is `coalesce(scheduled_day,
deadline_day)`. A task scheduled 2026-09-01 with a deadline of 2026-09-20 is invisible to a
2026-09-15..2026-09-25 window even though its deadline falls inside it. Not fixed on this branch
(the Tasks view is outside the task); the journal agenda does not reuse `filterTasks` for this
reason and matches both columns.
