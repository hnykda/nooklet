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

---

### B-172 · `block.update` with old_str/new_str rejects any block that has a property line or a second line
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, impl-journal (an e2e spec flipping
`TODO` to `DONE` on a task with `scheduled::` through the API) · **Test:** none yet; reproduced by
`tools/probes/block-update-property-roundtrip.ts`

`POST /api/v1/block.update {id, old_str: "TODO", new_str: "DONE"}` on the block
`- TODO buy milk` / `  scheduled:: 2026-09-13` answers 400 "content must describe exactly one
block". The same happens for a block whose content has two lines. The op's own description tells
agents to use old_str/new_str "for a small edit like flipping a marker", so an agent cannot finish
a dated task that way. Cause (read, and confirmed by the probe): `renderSingleBlockText`
(`packages/server/src/ops/outline-bridge.ts`) strips the two-space indent from continuation and
property lines, and `parseSingleBlockGrammar` prepends `- ` only to the first line, so the edited
text parses as a block followed by stray top-level lines. Probably the same for `content` given
with unindented property lines, which is how the spec describes the grammar. Workaround used in
`e2e/tests/journal-agenda.spec.ts`: `properties: { marker: "DONE" }`. Not fixed here (server op,
outside this branch's task).

---

### B-173 · B-72's "palette closes and hands focus back to the editor" e2e fails on da85cfb
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-journal (running
`views.spec.ts` alongside the journal specs) · **Test:** `e2e/tests/views.spec.ts` "opening the
palette while editing and closing it hands focus back to the editor"

Fails 2 of 2 on this branch and 1 of 1 on a clean `git archive da85cfb` checkout (port 6403,
load average ~17): after Escape closes the palette, `.cm-content` is "inactive" rather than
focused for the whole 10 s. So it predates this branch. Not investigated: whether it is a
regression of B-72 since 2026-09-12 or something about headless focus on a loaded machine.

---

### B-174 · Typing in an earlier day of the journal stream drops out of editing after the first write
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, impl-journal (the real-graph
performance probe's typing step kept "losing" its editor) · **Test:**
`e2e/tests/journal-stream-editing.spec.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

On `/journals`, click a block on any day below Today and type: about half a second later (the
editor's debounced write) the caret is gone — focus drops to `<body>`, and further keys go nowhere.
Today's own section is not affected. Reproduced on a clean `git archive da85cfb` build against a
copy of the owner's graph: marking every `.journal-day` element, typing one character into the
first earlier day, and waiting 1.5 s left 1 of 29 sections as the same DOM element (Today's);
the other 28 had been replaced, and `.cm-content` no longer existed
(`scratchpad` probe `debug-remount.mjs`; the kept probe is `tools/probes/journal-agenda-perf.mjs`,
whose typing step failed the same way). Cause: `JournalStreamView` renders earlier and upcoming
days with `<For each={earlierDays()}>` over `JournalDayEntry` objects; every write refetches
`useJournalStream`, which builds new entry objects, and `<For>` is keyed by reference — so every
section, with its `BlockTree` and the editor inside it, is torn down and rebuilt on each write.
Today's section is a non-keyed `<Show>`, which is why it survives.

**Fixed 2026-09-13.** `JournalStreamView` iterates day NUMBERS (`laterDays`/`earlierDays` are
`number[]` memos with an element-wise `equals`) and reads each day's entry from an `entryByDay`
map inside the section, through a non-keyed `<Show>`. Numbers compare by value, so a section — and
the `BlockTree` and editor in it — lives as long as its day is in the stream. Tests that would have
caught it: `journal-stream-editing.spec.ts` "typing in an earlier day keeps editing across the
write, and every key lands (B-174)" (fails on a clean `da85cfb` build: the editor is gone after the
first write), and `JournalStreamView.test.tsx` "keeps every day's outline mounted when a write
refetches the stream (B-174)" (old view: 13 `BlockTree` mounts after three refetches instead of 4).

---

### B-175 · A web link inside a "Scheduled and deadline" row opens the task instead of the link
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal (real
Chromium against `nooklet serve` on a copy of the owner's graph plus seeded dated tasks) ·
**Test:** none yet

A task `TODO zavolat [[@Robin]] kvůli dárku https://example.com/darek` scheduled for today: in
today's agenda, clicking the `https://…` link opened no tab; the app navigated to
`/page/Úkoly — Čeština?block=…` instead. The `[[@Robin]]` link in the same row works (its handler
stops the event). Cause (read): `JournalAgenda.tsx`'s row `onClick` calls `preventDefault()` on
every click that bubbles up to it, and plain web links (`link`/`autolink` tokens in
`render/tokens.tsx`) have no handler of their own, so the browser's "open in new tab" is cancelled
and the row navigates. `QueryFenceView.tsx`'s hit rows have the same shape (`stop(e)` on the row)
and so very likely the same defect — not reproduced, not touched here.

---

### B-176 · Any write rebuilds every "Scheduled and deadline" row, dropping keyboard focus on one
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal · **Test:**
none yet

Reproduced in real Chromium on a copy of the owner's graph: Tab-focus an agenda row on today's
journal, then let any write land (here `page.append` to an unrelated page through the API — a sync
pull or an agent does the same) — `document.activeElement` becomes `<body>`. Marking the rows'
DOM nodes and typing one character anywhere in the stream replaced 5 of 5 rows; on a stress copy
(686 dated open tasks) 587 of 587 on every debounced write (~800 DOM mutations each; no frame over
50 ms on this machine, so it is a focus/selection defect rather than a speed one). Cause: the agenda
resource refetches on every `block` write and `agendaForDay` builds new group and entry objects;
`<For>` is keyed by reference, so each row is torn down and rebuilt — the B-174 pattern, one level
down.

---

### B-177 · After midnight, a day pinned from the calendar can be Today too, rendered twice
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal (B-170's
rollover with Playwright's fake clock) · **Test:** none yet

At 23:59 pin tomorrow from the stream's calendar (allowed: it is not today). At 00:00 B-170 moves
Today to that day, and the pinned section stays — the same journal page is rendered by two
editable `BlockTree`s one above the other (seen: Today and "Back to stream" sections both listing
block `1m2cv41ffra8gm`). Before B-170 "today" never changed while the view was mounted, so a pin
could never equal it.
