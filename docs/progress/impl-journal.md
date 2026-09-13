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

- `feat(web): agenda rows on a grid; dates drop under the text on a phone; journal-stream perf
  probe and numbers` — found by looking at screenshots of the stress copy at 1100 px (light) and
  400 px (dark): on a phone the flex row wrapped a two-date chip onto its own line at the far left.
  Now a three-column grid (glyphs, text, dates) that becomes two columns under 480 px.
  `tools/probes/journal-agenda-perf.mjs` finished; numbers below.

- `docs: PLAN §8, wiki Journals/Tasks, ADR 011 deferred list — the Scheduled and deadline
  section exists; midnight staleness fixed`.

- Final verification at `051a22f`: `pnpm -r typecheck` exit 0; biome clean on every file this
  branch touched; web unit 78 files / 715 tests passed; e2e (port 6403) journal-agenda,
  journal-stream-editing, journals, a-fresh-journal, templates, phone, focus, editing, pages,
  navigation, render, query, tasks, views — 134 passed, 1 failed (`views.spec.ts:461`, B-173,
  fails identically on a clean `da85cfb` build). `nooklet verify` not run: no op, sync or schema
  code changed.

## For the coordinator

- Fold `docs/bugs-inbox/impl-journal.md` into `docs/BUGS.md`: B-94 fixed, B-170 fixed, B-174
  fixed (high — editing any earlier stream day was broken), B-171 open (Tasks view due window),
  B-172 open (server `block.update` old_str/new_str on blocks with property lines — affects
  agents), B-173 needs-repro (palette focus e2e red on `da85cfb`).
- Owner decisions: (1) marker-less blocks with a date are not listed (tasks only); (2) no cap on
  the overdue list — a neglected graph lists every overdue task under Today.
- Shared-file touch: `JournalStreamView.tsx` (day-keyed `<For>`, agenda hookups, reactive today)
  and `PageView.tsx` (agenda section + `journalDay`); everything else is new modules.

## Performance (2026-09-13, machine load average 17-45, 5 warm runs each, medians)

Probe: `tools/probes/journal-agenda-perf.mjs`, port 6403, headless Chromium, persistent profile
per build per graph (replica bootstrapped once). "base" = `git archive da85cfb` with its own
production build; "branch" = this branch at the B-174 fix plus the grid CSS (same JS paths).

| graph | build | load /journals (ms) | load more (ms) | long tasks over 8 edits (ms) | agenda rows on screen |
|---|---|---|---|---|---|
| owner's copy (18.6k blocks, 0 dated open tasks) | base | 239 | 138 | n/a (B-174) | 0 |
| owner's copy | branch | 226 | 126 | 0 | 0 |
| stress copy (686 dated open tasks, 386 overdue) | base | 182 | 111 | n/a (B-174) | 0 |
| stress copy | branch | 337 | 148 | 0 | 625 |

Reading: on the owner's real graph the section costs nothing measurable (it is empty — the graph
has no open task with a date). On the stress copy the first render is ~150 ms slower because
Today's section renders ~390 rows (386 overdue) and the other visible days ~235 more; still a
third of a second. Editing produced no main-thread long task on either graph (the queries run in
the worker; the probe checks its typing landed, and a 200 ms busy loop registers as 199 ms, so the
observer works). Single outliers of ~2-2.8 s appeared in both base and branch runs (load).
The agenda SQL uses `block_marker` (EXPLAIN QUERY PLAN), guarded by a unit test.

Open question for the owner (not built): a graph with hundreds of forgotten dated tasks puts all of
them under Today. Logseq avoids that by not listing overdue non-repeating tasks at all; a cap
("and 356 more overdue → Tasks") would be the smallest fix. Left as-is because the brief asks for
overdue tasks and the owner's own graph has none.

## In flight

- Nothing mid-edit.

## Next steps

1. (done) day clock + B-94.
2. (done) agenda data + rules + component.
3. (done) hookups + B-170.
4. (done) e2e.
5. (done — see Performance) Real-graph perf check with `tools/probes/journal-agenda-perf.mjs`: base build
   (`scratchpad/impl-journal/base`, a `git archive da85cfb` with `apps/web/dist` built by its own
   e2e run) vs this branch, on the real copy and on a stress copy (686 dated open tasks, 386
   overdue — made by SQL on a copy, so `verify` on it is meaningless). One browser profile per
   build per graph (a shared profile's service worker served the other build's bundle). Record
   medians here. Note: the base build cannot run the probe's typing step (B-174 loses the editor),
   so compare load / load-more on base, and edit cost only between variants of this branch.

## How to resume

`git log --oneline da85cfb..m8/impl-journal`, then this file's Next steps.

## Adversarial verification (second agent, 2026-09-13)

Scratch: `scratchpad/impl-journal-verify/` (graph copy `graph/`, stress copy `stress/` with 686
dated open tasks made by SQL, probes `probe1..5.mjs`). Port 6403.

- Re-ran the branch's unit tests (34/34 in the 7 touched files) and e2e journal-agenda,
  journal-stream-editing, journals: 11/11.
- Real browser on the graph copy + seeded Czech tasks: grouping, overdue chips, [[link]] in a row,
  B-170 rollover with Playwright's fake clock (waits for 2 s of idle typing, then moves; Today
  A→B page switch works). Note for anyone repeating it: fake the clock FORWARD of real time or
  the server rejects/loses the edits (HLC drift / LWW), which looks like a product bug and is not.
- Found and fixed: B-175 (web link in an agenda row opened the task), B-176 (every write rebuilt
  every agenda row, dropping keyboard focus), B-177 (a calendar pin equal to the new Today was
  rendered twice). Commits: `66b0fa3` (log), `d83610d` (B-177), `2b676b2` (B-175, B-176).
- `97e00da` (B-176 follow-up): keyed rows alone still re-rendered every row's text on each write
  (stress copy: ~22k DOM mutations over 8 edits, vs ~6k before); a by-value memo per entry brings
  it to ~2.4-3.5k, rows 587/587 kept. Perf probe on the stress copy after all fixes: load median
  183 ms, load-more 114 ms, 0 ms long tasks while editing.
- Re-checked in the browser after the fixes: a web link in a row opens a new tab and the app stays
  on /journals; Tab-focus on a row survives an API write; typing keeps all rows; the pinned day
  disappears at midnight when it becomes Today.
- `35e591a`, `a423286`: `e2e/tests/journal-midnight.spec.ts` (2 tests, fake clock at 23:59:45 then
  fast-forward): Today's agenda and a `deadline:today` fence move to the new day. Both fail when
  `day-clock.ts#check` stops moving the day. Seeds a DEADLINE because `query.spec.ts` counts every
  open task scheduled for tomorrow (a scheduled seed broke it in a combined run).
- `2f98421` (B-178): the B-174 spec shared its journal day with `graph.spec.ts` and failed in a full
  run; now on its own day and its own block; still fails on `da85cfb`'s stream view.
- Final: web unit 78 files / 718 tests; `pnpm -r typecheck` exit 0; biome clean on all 21 branch
  files; full chromium e2e before B-178's fix: 294 passed, 2 failed (B-178, and `views.spec.ts:461`
  = B-173), 2 skipped; after: a-fresh-journal, graph, journal-agenda, journal-midnight,
  journal-stream-editing, journals, query, tasks, phone, focus — 76 passed.
- Not done: `nooklet verify` (no op/sync/schema change); the query fence's own hit rows likely have
  B-175 too (left open, logged).
