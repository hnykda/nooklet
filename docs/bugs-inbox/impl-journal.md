# Bugs inbox — impl-journal (M8)

Entries for `docs/BUGS.md`, written here so a dozen parallel branches do not conflict on it. The
coordinator folds them in. Format matches `docs/BUGS.md`.

---

### B-94 (existing) · A ```query fence keeps yesterday's "today" after midnight until something else changes
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12 while building the fence ·
**Test:** `apps/web/src/data/queries.today.test.ts`, `apps/web/src/data/day-clock.test.ts`

Unchanged from `docs/BUGS.md`: `useQueryResults` (`data/queries.ts`) re-runs only when
`block`/`block_prop`/`page` change, and `today` is read at evaluation time, so a page with
`scheduled:<=today` left open across midnight lists the previous day's results.

**Fixed 2026-09-13.** New `apps/web/src/data/day-clock.ts`: the local day as a Solid signal
(`currentDay()`), kept by a timer aimed just past local midnight (capped at five minutes, because
browser timers stop while a machine sleeps), `visibilitychange` to visible, and window `focus`.
`useQueryResults` puts `{ query, today: currentDay() }` in the resource source and passes that
`today` to `runQuery`, so a rollover re-evaluates with no table change. Put in its own module
rather than next to `stampedFor` in `store.ts` (as the entry suggested) so the journal views can
use it too without widening the store seam. Tests that would have caught it:
`queries.today.test.ts` — "re-evaluates `today` at local midnight without any table changing" and
"re-evaluates when the page becomes visible after sleeping through midnight" (both fail on the old
`queries.ts`: `expected [ 20260912 ] to deeply equal [ 20260912, 20260913 ]`); the clock itself in
`day-clock.test.ts` (midnight, visibility, focus, a sleep-paused timer, DST-safe midnight, one
notification per rollover).

---

### B-170 · The journal stream keeps yesterday as "Today" after midnight
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-journal (reading
`views/JournalStreamView.tsx` while adding the "Scheduled and deadline" section) ·
**Test:** `apps/web/src/views/streamToday.test.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

`JournalStreamView` reads `todayJournalDay()` once, when it mounts. A tab left open overnight —
the normal state of a desktop outliner — still shows yesterday under "Today" the next morning, with
no virtual row for the real today; typing lands on yesterday's page. Only navigating away and back
fixes it. Same root cause as B-94 (no signal for "the local day changed"); it matters more once the
day carries a "Scheduled and deadline" list, which would show yesterday's agenda as today's.

**Fixed 2026-09-13.** `views/streamToday.ts#createStreamToday` gives the stream a "Today" that
follows `data/day-clock.ts#currentDay()` (midnight timer, visibility, focus — see B-94). It holds
back only while input in the stream is less than two seconds old: moving "Today" unmounts the
`BlockTree` showing yesterday's page, and a typed edit still inside that tree's 500 ms debounce is
not flushed on unmount, so switching mid-sentence at 00:00 could drop keystrokes. An idle caret
does not hold the day back. Tests that would have caught it: `JournalStreamView.test.tsx` "moves
Today to the new day when the local day changes (B-170)" (fails on the old view: the virtual row
stays on the old day); `streamToday.test.ts` — midnight, visible-after-sleep, "waits for typing in
the stream to pause before moving, then moves", "does not wait on an idle caret". Not covered by
e2e: Playwright's clock could fake it, but the stream would need a page open across a fake
midnight; the unit tests drive the same signal.

---

### B-171 · The Tasks view's due-date window ignores a deadline when the task is also scheduled
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-journal (reading
`views/taskFilters.ts` for reuse) · **Test:** none

`filterTasks`' "Due from / Due to" compares `due_day`, which is `coalesce(scheduled_day,
deadline_day)`. A task scheduled 2026-09-01 with a deadline of 2026-09-20 is invisible to a
2026-09-15..2026-09-25 window even though its deadline falls inside it. Not fixed on this branch
(the Tasks view is outside the task); the journal agenda does not reuse `filterTasks` for this
reason and matches both columns.
