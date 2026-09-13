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
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 17:28; `data/` = NOOKLET_DATA).
E2E port 6414. Bugs go to `docs/bugs-inbox/repair-agenda.md` (new numbers B-480..B-489).

## Done (committed)

- (nothing yet)

## In flight

- Part 1: core helper `orgDateLine`/`findOrgDateLines` in `packages/core/src/outline.ts`, repair
  module `packages/server/src/repair/org-dates.ts`, CLI wiring.

## Real-graph facts (copy taken 17:28)

- 20 live blocks hold a `SCHEDULED:` line: 19 DONE, 1 unmarked; 19 on journal `2023-02-17`
  (`<2023-2-17 Fri>`), 1 on `2022-12-16` (`<2022-12-8 Thu>`). No `DEADLINE:` lines. All have
  `scheduled_day` NULL. 4 other blocks have `scheduled_day` set (all DONE).

## Decisions

## Next steps

1. Part 1 code + unit tests (plan/apply/undo), CLI flags test.
2. Run dry-run + apply on the graph copy; `verify`; chips check in a browser.
3. Part 2 baseline perf with `tools/probes/journal-agenda-perf.mjs` on a copy (base build).
4. Part 2 code + unit + e2e; perf after.

## How to resume

`git log --oneline 52e5d20..m11/repair-agenda`, then this file's Next steps.
