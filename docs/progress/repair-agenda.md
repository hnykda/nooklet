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
E2E port 6414; manual serves on 6415. Bugs go to `docs/bugs-inbox/repair-agenda.md` (new numbers
B-480..B-489).

## Done (committed)

- `524cf49` Part 1 code: `nooklet repair org-dates [--apply]` — `core/outline.ts`
  (`orgDateLine`, `findOrgDateLines`; the parser now calls `orgDateLine`),
  `server/repair-org-dates.ts`, `server/cli-args.ts#parseRepairFlags`, `server/cli.ts` case
  `repair`. Tests: core `outline-org-dates.test.ts` (+4), server `repair-org-dates.test.ts` (6),
  `cli-args.test.ts` (+2). Unit: core 412/412, server 684/684; typecheck clean.
- (next commit) docs: `OPERATIONS.md` §10, wiki `Command line`, inbox B-143 (existing), this file.

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

## Next steps

1. (done) Part 1 code + unit tests.
2. (done) Dry-run + apply on the graph copy; `verify`; chips; undo.
3. Part 2 baseline perf with `tools/probes/journal-agenda-perf.mjs` on a copy (base build).
4. Part 2 code + unit + e2e; perf after.

## How to resume

`git log --oneline 52e5d20..m11/repair-agenda`, then this file's Next steps.
