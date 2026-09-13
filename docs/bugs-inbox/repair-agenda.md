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
Checked since (verification, `tools/probes/repair-org-dates-open-window.mjs` on a fresh copy): with
`serve` running and a window open, `--apply` succeeds (no busy error), but the open window shows
nothing for 15 s — the server never learns of another process's write, so it pokes no client — and
shows the chips only after a reload; `batch.undo` over HTTP then reaches open windows live (~0.5 s).
So "quit the app first" is required, not a precaution.

---

### B-480 · `review-reactivity.spec.ts`'s "Older changes" retry once listed 25 history batches instead of 26
**Status:** needs-repro · **Severity:** low (test harness, probably) · **Found:** 2026-09-13,
repair-agenda, e2e run of 32 specs (`references-filters` … `views`, alphabetical) on port 6414 at
load average ~100 · **Test:** `e2e/tests/review-reactivity.spec.ts` "a failed Older changes says
so instead of silently re-enabling the button (B-131)"

After the aborted "Older changes" load showed its error and the route was removed, the second click
left `.history-batch` at 25 for the whole 10 s (`expect … toHaveCount(26)`, line 182). The same
spec alone right after: 7/7. Nothing on this branch touches History or `page.history`. Unexplained;
one guess not checked: `page.unroute` and the click racing, so the retry went through the abort
route too but the error line had already been cleared. The trace is gone (the next run on 6414
wiped `e2e/test-results/6414/`); the failure output is in the repair-agenda scratch dir,
`e2e-chunk3.log`.

---

### B-481 · `repair org-dates` left a blank last line where a re-import leaves none
**Status:** fixed · **Severity:** low (no block on the owner's graph has the shape) · **Found:**
2026-09-13, repair-agenda verification · **Test:** `packages/server/src/repair-org-dates.test.ts`
"leaves the text a re-import would: no blank last line where the date line was"

The repair took only the date line out: `Mirek⏎⏎SCHEDULED: <2023-2-17 Fri>` became `Mirek⏎`, an
empty last line in the editor. `parseOutline` drops a block's trailing blank lines, so a re-import
of the same block gives `Mirek` — the repair's stated contract. Found by running `findOrgDateLines`
plus the repair's line filter against `parseOutline` on nine shapes; the other eight agreed. Fixed by
dropping trailing blank lines from the repaired text, as the parser does. The owner's 20 blocks are
all `<title>⏎SCHEDULED: <…>`, so their dry run is unchanged (checked on a fresh copy after the fix).
The new test fails with the trim disabled (checked).
