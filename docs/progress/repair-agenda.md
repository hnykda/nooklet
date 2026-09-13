# M11 progress — repair-agenda

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief (two owner-approved items):
1. `nooklet repair org-dates [--apply]` — dry-run by default; finds block content lines of the org
   timestamp shape the importer understands (B-143, OUT-23), and through `serverApplyOps` writes the
   real scheduled/deadline/repeat and removes the text line, in ONE batch (undoable with
   `batch_undo`). Test on a real-graph copy (20 such blocks on the owner's graph): report blocks
   found (id, page, before/after), apply on the copy, `verify` OK, dates show as chips. Never run
   against `~/.nooklet/default` — the coordinator does that after reading the report.
2. Journal "Scheduled and deadline" section: also list dated blocks that are NOT tasks, on their
   exact day only (never overdue); collapse the overdue list beyond 10 items behind a "Show all N"
   toggle. Playwright tests for both; journal stream stays fast on the real-graph copy (measure
   before/after).

Branch `m11/repair-agenda` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_975bcd44-fae-5`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/repair-agenda/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 17:28, now repaired;
`graph-pristine.sqlite` = untouched copy of that backup; `data/` = NOOKLET_DATA).
E2E port 6414; manual serves on 7414/7415 (6415 until 17:59 — see Incident). Bugs go to `docs/bugs-inbox/repair-agenda.md` (new numbers
B-480..B-489).

## Done (committed)

- `524cf49` Part 1 code: `nooklet repair org-dates [--apply]` — `core/outline.ts`
  (`orgDateLine`, `findOrgDateLines`; the parser now calls `orgDateLine`),
  `server/repair-org-dates.ts`, `server/cli-args.ts#parseRepairFlags`, `server/cli.ts` case
  `repair`. Tests: core `outline-org-dates.test.ts` (+4), server `repair-org-dates.test.ts` (6),
  `cli-args.test.ts` (+2). Unit: core 412/412, server 684/684; typecheck clean.
- `7693124` docs: `OPERATIONS.md` §10, wiki `Command line`, inbox B-143 (existing), this file.
  Part 2: `29e6bc3` code, `15e1224` e2e.
- Part 2 code: `web/data/agenda.ts` (SQL takes `marker IS NULL` too, via `due_day IS NOT NULL`),
  `web/views/agendaDay.ts` (`agendaSection`, `OVERDUE_SHOWN = 10`, notes never overdue),
  `web/views/JournalAgenda.tsx` (bullet row, "Show all N overdue" / "Show fewer overdue" toggle,
  `aria-expanded`), `journal-agenda.css`, `web/db/schema-client.ts` + `worker-core.ts` (client-only
  `block_dated` index on every open), probe `tools/probes/agenda-sql-cost.mjs`. Unit: web
  1,146/1,146 (+agenda.test 1 changed, agendaDay +4, JournalAgenda +3, worker-core +1).
- e2e `journal-agenda.spec.ts` +2 (non-task row; overdue toggle incl. live count), first test made
  robust (opens the full list first). 10/10 with `journal-midnight.spec.ts`; the 2 new ones fail
  against the base UI code (checked by restoring it).

## Part 1 report — real-graph copy (for the coordinator)

Copy: `sqlite3 ~/.nooklet/default/graph.sqlite ".backup …/graph/graph.sqlite"` at 17:28. Full
output of the apply: `…/apply-report.txt` in scratch.

Dry run found exactly 20 blocks, 0 left alone, and wrote nothing (op count 20,442 before and after):

| block id | page | marker | before (text) | after (text; date) |
|---|---|---|---|---|
| 1m287mdbejacvt | 2022-12-16 | DONE | `odpovědět kolegovi [Slack](…p1670269773786849)⏎SCHEDULED: <2022-12-8 Thu>` | first line only; scheduled 2022-12-08 |
| 1m287mdbf2xgj6 | 2023-02-17 | DONE | `Mirek⏎…` | `Mirek`; 2023-02-17 |
| 1m287mdbf2xgj8 | 2023-02-17 | DONE | `zavolat podlaháři⏎…` | `zavolat podlaháři`; 2023-02-17 |
| 1m287mdbf2xgj9 | 2023-02-17 | DONE | `Nabít baterku⏎…` | `Nabít baterku`; 2023-02-17 |
| 1m287mdbf2xgja | 2023-02-17 | DONE | `Buy batteries⏎…` | `Buy batteries`; 2023-02-17 |
| 1m287mdbf2xgjb | 2023-02-17 | DONE | `napsat e-mail⏎…` | `napsat e-mail`; 2023-02-17 |
| 1m287mdbf2xgjc | 2023-02-17 | DONE | `napsat že ne⏎…` | `napsat že ne`; 2023-02-17 |
| 1m287mdbf2xgjd | 2023-02-17 | DONE | `opravit si sluchátka⏎…` | `opravit si sluchátka`; 2023-02-17 |
| 1m287mdbf2xgje | 2023-02-17 | DONE | `Oskar⏎…` | `Oskar`; 2023-02-17 |
| 1m287mdbf2xgjm | 2023-02-17 | DONE | `vymyslet svačiny na výlet⏎…` | `vymyslet svačiny na výlet`; 2023-02-17 |
| 1m287mdbf2xgjn | 2023-02-17 | DONE | `Vyměnit vodu v akváriu⏎…` | `Vyměnit vodu v akváriu`; 2023-02-17 |
| 1m287mdbf2xgjp | 2023-02-17 | DONE | `Přeposlat informace sousedům⏎…` | `Přeposlat informace sousedům`; 2023-02-17 |
| 1m287mdbf2xgjq | 2023-02-17 | DONE | `workshop download⏎…` | `workshop download`; 2023-02-17 |
| 1m287mdbf2xgjr | 2023-02-17 | (none) | `poslechnout nové album⏎…` | `poslechnout nové album`; 2023-02-17 |
| 1m287mdbf2xgjs | 2023-02-17 | DONE | `water flowers⏎…` | `water flowers`; 2023-02-17 |
| 1m287mdbf2xgjt | 2023-02-17 | DONE | `slušné boty koupit⏎…` | `slušné boty koupit`; 2023-02-17 |
| 1m287mdbf2xgjv | 2023-02-17 | DONE | `nechat si opravit brýle a najít si staré⏎…` | first line only; 2023-02-17 |
| 1m287mdbf2xgjw | 2023-02-17 | DONE | `get groceries⏎…` | `get groceries`; 2023-02-17 |
| 1m287mdbf2xgjx | 2023-02-17 | DONE | `Throw away my old suitcase⏎…` | first line only; 2023-02-17 |
| 1m287mdbf2xgjy | 2023-02-17 | DONE | `send follow up⏎…` | `send follow up`; 2023-02-17 |

(`⏎…` = `⏎SCHEDULED: <2023-2-17 Fri>`. None of these blocks had any date before.)

- `--apply`: "repaired 20 blocks in one batch (40 ops)"; `changes`: 20 rows, one batch_id, origin
  `system`, actor `repair:org-dates`. `verify`: OK, 20,482 ops.
- After: 0 blocks with `SCHEDULED:`/`DEADLINE:` text; 24 with `scheduled_day` (= a fresh re-import).
- Chips: served the copy (port 6415, `--no-mirror`, this branch's production build) and ran
  `tools/probes/date-chips-real-graph.mjs`: `/page/2023-02-17` 26 rows, 19 chips (18
  `vr-date-closed`, 1 `vr-date-past` = the unmarked block), picker opens on 20230217, no page or
  console errors. Screenshot `…/real-2023-02-17.png` in scratch (looked at: chips "Feb 17, 2023"
  beside each row).
- Undo: `POST /api/v1/batch.undo {"batch_id": …}` (write token made on the copy) → all 20 blocks
  back; a dump of every `1m287mdb%` block (id, content, marker, scheduled_day, repeat) is
  byte-identical to the pristine copy's; the undo's 144 ops are all server-device ops (no client
  writes). Then `verify` OK (20,626), `--apply` again (verify OK, 20,666), a third run: "nothing to
  repair".

## Real-graph facts (copy taken 17:28)

- 20 live blocks hold a `SCHEDULED:` line: 19 DONE, 1 unmarked; 19 on journal `2023-02-17`
  (`<2023-2-17 Fri>`), 1 on `2022-12-16` (`<2022-12-8 Thu>`). No `DEADLINE:` lines. All have
  `scheduled_day` NULL. 4 other blocks have `scheduled_day` set (all DONE).
- 0 open tasks with a date; 0 unmarked blocks with a date before the repair (1 after it, on its
  own journal day, so the agenda does not list it there).

## Decisions

- Repair is a CLI module, not a `defineOp` op: a one-off for data an old importer wrote, not a
  capability for agents. It still writes only through `serverApplyOps`.
- Refuse rather than guess: a text date that disagrees with an existing column value, or two
  different dates/repeats of one kind in one block → listed as "LEFT ALONE", untouched. (The parser
  lets the last line win; on live data that could overwrite a date someone set after the import.)
- All or nothing: plan and write inside one savepoint; any op not `applied` → rollback + throw.
- Seed the CLI's HLC from the target fields' HLCs before minting (a fresh process's clock could be
  behind a device that ran ahead, turning an op into a noop).
- Trashed blocks are not repaired (restoring one brings back its old text — no worse than now).
- Agenda: "not a task" = `marker IS NULL`. DONE/CANCELED stay off the agenda (they are tasks,
  finished). A note is listed on its exact day (scheduled or deadline), never overdue.
- Collapse keeps the PREFIX of the full list (oldest overdue first, the established order), so
  expanding only adds rows. An entry also due today is never held back. N counts overdue-only
  entries. Button text is "Show all N overdue" (the word "overdue" added so N is not read as the
  section's total) / "Show fewer overdue". Expanded state is per section instance, not remembered.
  Alternative not built: show the 10 most RECENT overdue (likelier still relevant) — would need the
  list order flipped; owner's call if wanted.
- `block_dated` is a CLIENT-only index, not in core DDL / server migrations: the server never runs
  the agenda read, and a server index would bump `SCHEMA_VERSION` 6→7 — an installed app on 6
  refuses a database a newer CLI has opened ("newer than this build supports"), which is exactly
  what running `nooklet repair` from this branch on the live graph would do. Spec rule 1 amended.

## Part 2 measurements (2026-09-13, load average 70-120 on this shared machine)

`tools/probes/agenda-sql-cost.mjs` (native node:sqlite, median of 50, no ANALYZE — the app never
runs it, and with it the planner picked different plans):

| copy | tasks-only read (base) | new read, no index | new read, `block_dated` |
|---|---|---|---|
| real (18,631 blocks; 1 dated note, 0 dated open tasks) | 0.012 ms, 0 rows | 2.0-2.3 ms (`SCAN b USING INDEX block_page`), 1 row | 0.006 ms, 1 row |
| stress (686 dated open tasks / 605 overdue + 401 dated notes, made by SQL) | 1.2 ms, 686 rows | 5.2 ms, 1,087 rows | 1.4 ms, 1,087 rows |

`tools/probes/journal-agenda-perf.mjs`, 5 warm runs, medians, base (`52e5d20` build) and branch
servers side by side on two copies of each graph (ports 7415/7414), runs interleaved:

| graph | build | load /journals (ms) | load more (ms) | long tasks over 8 edits (ms) | agenda rows on screen |
|---|---|---|---|---|---|
| real | base | 125, 126 | 86, 88 | 0 | 0 |
| real | branch | 127, 124 | 90, 90 | 0 | 0 |
| stress | base | 167, 177 | 95, 100 | 0 | 669 |
| stress | branch | 159, 135 | 98, 85 | 0 | 177 (today: 10 overdue + notes) |

Reading: no measurable cost on the real graph; on the stress graph the branch is faster because
Today renders 10 overdue rows instead of 605. One 2.1 s load outlier in one branch run (both builds
had such outliers in impl-journal's runs too). The editing probe runs the queries in the worker,
so it cannot see their cost — that is what the SQL probe is for.

Real browser replica: `tools/probes/replica-index-opfs.mjs` copies the OPFS database out of a
persistent Chromium profile and lists `block`'s indexes: a replica created by the base build and
then opened once with the branch build has `block_dated` (upgrade path), as does a fresh one; plan
on that copy: `SEARCH b USING INDEX block_dated (due_day>?)`. Screenshots on the stress copy
(`…/stress-today.png`, `…/stress-toggle.png` in scratch): notes with a grey dot aligned with the
checkbox glyphs, "Show all 605 overdue" under Today's list, 615 rows after clicking.

Incident to report: at ~18:01 my perf server failed to bind 6415 (EADDRINUSE — another agent's
server there by then; I had served my copies on 6415 from ~17:30 to ~17:59, which may have made
that agent's e2e start refuse "already serving"). My probe then drove a browser against THAT server
for up to two attempts; the second met "This device holds a different graph" and never typed. The
first attempt's output was lost (it ended in an error), so it may have bootstrapped their graph and
typed 8×"x" then 8×Backspace into a block on an earlier journal day. Moved to ports 7414/7415 and
now wait for my own "nooklet serving <my dir>" log line before probing.

## Whole suites on the final code (2026-09-13, ~18:30-18:50, load average ~100)

- Chromium e2e, port 6414, all 97 specs in three runs (the tool call caps at 10 min, so one
  server per run — cross-spec state is shared within a run, not across): specs 1-33 (`a-fresh-journal`
  … `journal-midnight`) 177 passed, 1 skipped; 34-65 (`journal-stream-editing` … `references-cap`)
  191 passed; 66-97 (`references-filters` … `views`) 167 passed, 1 skipped, 1 failed —
  `review-reactivity.spec.ts` B-131 "Older changes" (25 history batches instead of 26), 7/7 alone
  right after; nothing here touches History; logged as B-480 (needs-repro). Total 535 passed,
  2 skipped, 1 failed-then-passed. After that the backlog test's dates moved 11 years back (literal
  `scheduled:: 2026-09-20` in other specs turns overdue with the calendar and would otherwise
  overtake them in a few months); agenda + midnight specs again: 10/10.
- Unit: core 412/412, server 684/684 (after part 1; untouched since), web 1,146/1,146 (after part
  2's last code change). `pnpm -r typecheck` clean. Biome clean on every changed file.
- `verify` on the repaired real-graph copy: OK (20,482 and 20,666 ops). The server schema did not
  change (the index is client-only).

## Adversarial verification (2026-09-13, ~18:50-19:30, second agent)

Scratch `…/scratchpad/m11/repair-agenda-verify/`; fresh `.backup` of the owner's graph at 18:53
(20,463 ops — the owner kept writing since 17:28; still exactly the same 20 blocks).

- Unit, re-run: core 412/412, server 684/684 → 685/685 with B-481's test, web 1,146/1,146;
  `pnpm -r typecheck` clean.
- CLI flags: `repair`, `repair org-date`, `--aply`, `--apply --dry-run`, `--no-dry-run`, an extra
  positional all stop with a message and exit 1; `--apply=false` / `--no-apply` are dry runs.
- Real copy: dry run = the 20-block table above, 0 writes; `--apply` 40 ops, one batch, 20 `changes`
  rows (origin `system`, actor `repair:org-dates`); `verify` OK (20,503); FTS: `SCHEDULED` hits 28 → 8
  (the rest are prose); `nooklet export` writes `scheduled:: 2023-02-17` under each block, no
  `SCHEDULED:` left; 2022-12-16's block shows a "Dec 8, 2022" chip (`vr-date-closed`).
- Open window during the repair (`tools/probes/repair-org-dates-open-window.mjs`, run twice on fresh
  copies): `--apply` succeeds while `serve` runs, but an open window shows nothing for 15 s (no poke);
  after reload 19 chips; a fresh context 19 chips; `batch.undo` over HTTP reaches both windows live
  (~0.5 s); `verify` OK. After a restart the live mirror renders the repaired pages. OPERATIONS §10
  now says why quitting the app first is required.
- B-481 (fixed, `dfc07ed`): trailing blank line left where a re-import leaves none; not a shape on the
  owner's graph — `--apply` output on a fresh copy is byte-identical before and after the fix.
- E2E, ONE run of the whole Chromium suite on 6414 (not chunked, so cross-spec state carries all the
  way): 536 passed, 2 skipped, 0 failed (12.8 min). Then journal-agenda + journal-midnight with two new
  tests: 12/12 — a note made a task on a second browser context (its own OPFS replica) joins
  today's overdue list live and `Mod+z` there takes it back off, heading "Agenda/Poznámky čáp" opens
  that page; a `/deadline` picked "today" on a note in a second context lists it under today with a
  bullet, caret back in the editor, undo removes it.
- `tools/probes/agenda-sql-cost.mjs` on the repaired copy: new read 0.007 ms via `block_dated`
  (6.9 ms without the index under load ~80), base 0.012 ms.

## Next steps

1. (done) Part 1 code + unit tests.
2. (done) Dry-run + apply on the graph copy; `verify`; chips; undo.
3. (done) Part 2 perf before/after.
4. (done) Part 2 code + unit + e2e.
5. (done) Whole suites.
6. Coordinator: read the Part 1 report, quit the app, `pnpm nooklet repair org-dates` (dry run)
   then `--apply` on `~/.nooklet/default`; keep the printed `batch_id`.

## How to resume

`git log --oneline 52e5d20..m11/repair-agenda`, then this file's Next steps.
