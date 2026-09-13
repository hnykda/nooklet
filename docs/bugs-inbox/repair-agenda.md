# Bug inbox — repair-agenda (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-480..B-489.

---

### B-143 (existing)

**Repair written 2026-09-13; not yet run on the owner's graph.** The "Not done — needs the owner"
half: `nooklet repair org-dates [--apply]` (`packages/server/src/repair-org-dates.ts`) finds the
org timestamp lines an import before the fix left in block text, using the parser's own rule
(`core/outline.ts#orgDateLine`/`findOrgDateLines`, now shared with `parseOutline`), and writes the
real `scheduled`/`deadline`/`repeat` plus the text without the line — one `serverApplyOps` batch,
all or nothing, undoable with `batch_undo`. Dry run by default. Refuses (lists, leaves alone) a
block whose text disagrees with a date it already has or names two dates of one kind.
On a `.backup` copy of `~/.nooklet/default` taken 2026-09-13 17:28: the dry run listed exactly the
20 blocks (19 DONE + 1 unmarked; 19 on `2023-02-17`, 1 on `2022-12-16` with `<2022-12-8 Thu>`),
0 left alone; `--apply` wrote 40 ops in one batch; `verify` OK (20,482 ops); 0 blocks with
`SCHEDULED:` text left, 24 with `scheduled_day` (the same as a fresh re-import);
`tools/probes/date-chips-real-graph.mjs` on `/page/2023-02-17`: 19 chips (18 closed, 1 past), no
console errors. `batch.undo` over HTTP with the printed `batch_id` restored every block
byte-identical to the pre-repair copy (`verify` OK), and a second `--apply` repaired them again
(`verify` OK, 20,666 ops); a third run: "nothing to repair".
**Tests:** `packages/server/src/repair-org-dates.test.ts` (6: dry run writes nothing; one batch
that `verify` replays; `batch.undo` restores; the refusals; wins over a field HLC 30 s ahead —
fails if the clock is not seeded from the fields first, checked; all or nothing on a throw),
`packages/server/src/cli-args.test.ts` › "parseRepairFlags" (2),
`packages/core/src/outline-org-dates.test.ts` › "findOrgDateLines" (4).
**Still for the coordinator:** run it on `~/.nooklet/default` with the app quit (dry run first).
Not checked: whether a window left open during the repair shows it before its next reconnect.
