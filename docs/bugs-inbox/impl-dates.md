# Bugs inbox · impl-dates

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on that file. The
coordinator folds them in. New numbers from B-140..B-149 only.

---

### B-96 (existing)
`/scheduled`, `/deadline` and the date commands do nothing.

**Fixed 2026-09-13.** `app/CommandLayer.tsx` now hands the command set the real host
(`app/date-picker.ts` → `commands/date-picker/host.ts`) instead of `createFakeDatePickerHost()`.
`task.setScheduled`/`task.setDeadline` open a keyboard-first picker
(`commands/date-picker/DatePicker.tsx`, spec R38): type a date — `tomorrow`, `fri`, `+3d`,
`2026-09-20 14:00`, `20.9.`, `every week`, `none` (`commands/date-picker/parse.ts`) — or move the
highlight with the arrows (±1/±7 days, PageUp/PageDown a month), Enter sets, Escape cancels.
The editor keeps DOM focus throughout, so the caret is where it was when the picker closes. Keys
are taken in the window's capture phase and the popup keys are claimed through
`claimPopupKeys`; a document-level listener (as `TemplatePicker` uses) was tried and loses to the
global keymap in block selection: Backspace deleted the selected block (verified by swapping the
listener and re-running the e2e test below, which then failed with the block gone). A pick is one
`setBlockProps` batch (`scheduled`/`deadline` in ADR 011's `YYYY-MM-DD[ HH:MM]`, plus `repeat`
when one was typed). With an argument (an agent through `ui_run`) the commands write directly
with no picker.
**Test:** `e2e/tests/dates.spec.ts` "/scheduled, type tomorrow, Enter: scheduled:: is stored, the
chip appears, the caret never left (B-96)" (would have caught it: no `.date-picker` ever
appeared), plus "/deadline with a typed ISO date and time, then arrows…", "Escape cancels…",
"from block selection, the palette's Set deadline date opens the picker and Backspace edits the
date, not the selection"; unit: `commands/date-picker/{parse,host}.test.ts`,
`DatePicker.test.tsx`.

---

### B-102 (existing)
A task's scheduled/deadline date is not shown on its row.

**Fixed 2026-09-13.** `editor/DateChips.tsx` (one hookup line in `BlockRowView.tsx`) renders a
chip per date at the end of the row — relative label (Today, Tomorrow, Fri, Sep 20, Sep 20 2027,
with the time), `vr-date-overdue` on an open task whose date is before today, `vr-date-today`,
muted on DONE/CANCELED, plain `past` on a non-task. "Today" is a signal re-armed at local
midnight and on tab re-show, so a page left open overnight turns overdue without a refetch.
Clicking a chip opens the picker on that date, anchored under the chip, without entering edit
mode; the picker's Remove button clears it.
**Test:** `e2e/tests/dates.spec.ts` "chips: overdue on an open task, muted on a closed one, plain
on a note or a future date (B-102)" and "clicking a chip opens the picker on that date without
entering edit mode; a new date rewrites it; Remove clears it"; unit: `editor/date-chips.test.ts`.

---

### B-140 · A row-rendering module that imports the `lucide-solid` barrel stalls anything that renders a row under vitest
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (while adding chips) ·
**Test:** `apps/web/src/editor/render/render-seams.test.tsx` (the three ```` ```query ```` fence
tests time out when it regresses)

Seen while building B-102, never shipped: the first cut of `editor/DateChips.tsx` imported
`{ CalendarClock, Flag, Repeat } from "lucide-solid"`. `BlockRowView` imports it, and
`QueryFenceView`/`Shelf` import `BlockRowView` (for `MARKER_GLYPH`), so the query fence's lazy
view took longer than five seconds to load under vitest — the barrel re-exports 1,821 icon
modules and vitest, unbundled, evaluates each — and three `render-seams.test.tsx` tests timed
out waiting for it. Evidence: a one-off probe test that `import()`ed `QueryFenceView.js` hit
vitest's 5 s timeout with the barrel import, and passed once the three icons were imported by
path; moving the chip's static `app/date-picker.ts` import to click time first, on its own, did
not make the failing tests pass. Recorded because the trap is still set: the shell
(`Sidebar.tsx`, `AppShell.tsx`, `Shelf.tsx`, `HelpMenu.tsx`, `ReferencesPanel.tsx`) imports the
barrel, which is harmless only as long as no unit test renders those. In the production build
Vite tree-shakes the barrel, so this is a test-time cost, not a bundle one (not measured).

**Fixed 2026-09-13.** `DateChips.tsx` imports one file per icon
(`lucide-solid/icons/calendar-clock` …). It also loads `app/date-picker.ts` (and with it the data
layer) on click rather than at module load — not needed for the timeout, but a row renderer that
the shelf and the query fence share should not drag the replica client in.

---

### B-141 · The date picker's error line names only the first letter typed
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (screenshot review of
this branch's own picker; never on main) · **Test:** `apps/web/src/commands/date-picker/DatePicker.test.tsx`
"Enter on text that is not a date does nothing but say so; Backspace edits the text"

Type `bananas` into the picker and press Enter: the red line says `"b" is not a date — …`. The
line was `<Match when={invalidMessage()}>{(message) => message()}</Match>`. Solid's `Switch`
calls a Match's render function once, inside `untrack`; a function that returns the accessor's
value as a bare string (rather than JSX that reads it) captures the first message and never
updates while the condition stays truthy. No other `{(x) => x()}` render callback exists in
`apps/web/src` (grep, 2026-09-13).

**Fixed 2026-09-13.** The Match renders `{invalidMessage()}` as JSX, which Solid tracks. The test
named above now asserts the whole `"banana" is not a date`; run against the old line it failed
with `Received: ""b" is not a date — try tomorrow, fri, +3d or 2026-09-20"`.

---

### B-142 · Cmd/Ctrl+Z does not undo a date set with the date picker
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** none yet;
probe `tools/probes/picked-date-undo.spec.ts`

`/scheduled`, `tomorrow`, Enter, then Cmd+Z: the chip stays and the server still has
`scheduled:: <tomorrow>` 1.5 s later (probe output: `scheduled after Cmd+Z: 2026-09-14`). The picker
writes through the command `Store` (`app/hosts.ts#setBlockProps` → `applyOps`), and undo is
`BlockTree`'s `EditHistory`, which only records what goes through `BlockTree#commit`. By reading
the code, every `ctx.store` task command has the same gap — `task.setPriorityA/B/C` and the
palette's `task.setMarker*` use `ctx.store.setBlockProp` — but only the date case was run.
Fix needs a seam, not a patch in the picker: an `EditorHost` (or store) method that commits ops
through the active tree's history, used by every store-routed command. `BlockTree.tsx` is a
shared file this milestone, so not done on this branch.

---

### B-143 · Import keeps `SCHEDULED: <2023-2-17 Fri>` as text and loses the date when Logseq wrote a one-digit month or day
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-dates (checking chips
against a copy of the owner's graph)

In a copy of `~/.nooklet/default/graph.sqlite` only 4 blocks have `scheduled_day`, and 20 more
still carry a literal `SCHEDULED: <2023-2-17 Fri>` line in their content — so they show no chip,
sort nowhere in the Tasks view, and read as text. The Logseq source graph
(`~/notes-graph`) has exactly 24 `SCHEDULED:` lines: 4 zero-padded
(`<2023-01-06 Fri>`) and 20 not (`<2023-2-17 Fri>` ×19, `<2022-12-8 Thu>` ×1) — the 20 lost ones.
(Survey: `grep -rhoE "(SCHEDULED|DEADLINE): <[^>]*>" journals pages`, digits folded.) Cause:
`packages/core/src/outline.ts` `TIMESTAMP_INNER_RE` takes the date as `\d{4}-\d{2}-\d{2}` only,
and a non-matching timestamp falls through to content "so no data is lost". The same regex
takes the time as `\d{1,2}:\d{2}` and stores it unpadded, while the reducer
(`sync/apply-ops.ts#SCHEDULED_RE`) only accepts `HH:MM` — a `<2026-09-14 Mon 9:30>` would be
parsed into a value the reducer rejects (no such line exists in the owner's graph).

**Fixed 2026-09-13.** `outline.ts#orgTimestamp` accepts one-digit month, day and hour, zero-pads
them, and rejects an impossible date or time (kept as text, as before). Grammar spec OUT-23 rule
5 says so. Checked on real data: a fresh `pnpm nooklet import ~/notes-graph
--data <scratch>` now has 24 blocks with `scheduled_day` (was 4) and 0 blocks with
`SCHEDULED:`/`DEADLINE:` text (was 20); `pnpm nooklet verify` on it: 19,580 ops replayed, OK.
**The owner's live graph is not repaired by this** — the 20 blocks keep their text until the
graph is re-imported (or someone runs a one-off fix; none written).
**Test:** `packages/core/src/outline-org-dates.test.ts` (4 tests, all failed before the fix) and
`packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE written with one-digit
month, day and hour (B-143)" (fails against the old parser — checked by restoring it).

---

### B-144 · Two web unit tests fail under load: the query fence's first render and `page-title`'s first test
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** the
tests themselves

On the shared machine, `pnpm -r test` and `apps/web` `vitest run` intermittently failed
`src/editor/render/render-seams.test.tsx` "says what is wrong, and where, for a query that does
not parse" (its `waitFor`, default 1 s, gives up before the lazy `QueryFenceView` import has
resolved — the DOM dump shows the plain `<pre>` fallback) and `src/data/page-title.test.ts`
"renders a journal by its day and an ordinary page by its name" (its first `vi.resetModules()` +
`import()`; message not captured). Both pass alone, every time tried (4/4). Not caused by this
branch: with `editor/BlockRowView.tsx` swapped back to `da85cfb`'s, 3 of 3 full `apps/web` runs
had one or two of these failures; with this branch's, 3 of 8 runs (counting one `pnpm -r test`)
had one, and the last 3 in a row were clean. A timed probe of the
`QueryFenceView` import alone measured 0.9–3.7 s depending on machine load. Likely fix: a longer
`waitFor` timeout on the first lazy render, and a per-test timeout on the first cold import.

---

### B-145 · The date picker stores a garbage date for `+10000y` and throws on every keystroke of `+99999999d`
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-dates` (a real browser against the production build) · **Tests:**
`apps/web/src/commands/date-picker/parse.test.ts` "an offset that leaves the calendar is not a date
— never a garbage or NaN day (B-145)" and "refuses to format a day that is not on the calendar…",
`DatePicker.test.tsx` "a typed offset past the calendar's end is an error line, not a crash or a
write (B-145)", `e2e/tests/dates.spec.ts` "while the picker is open, the structural keys never
reach the tree, and a date past the calendar is refused without an error (B-145)" (fails against
the pre-fix parser: Enter closed the picker having written nothing)

Offsets were the one input with no size limit. `/scheduled`, `+10000y`, Enter: the preview said
"Sun, Sep 13, 12026", and the server then held `scheduled:: 1202-60-91` — `formatStoredDate`
sliced the nine-digit day `120260913` into four-two-two, and the reducer's `SCHEDULED_RE` checks
only the digit pattern, so `scheduled_day` became `12026091`: no chip (the chip parser rejects
it), but a due date in the year 1202 for the Tasks view and every `scheduled:<today` query.
`+99999999d` goes past what `Date` holds: `addDays` returned NaN, `formatJournalTitle` threw
`RangeError: Invalid time value` from the preview (two uncaught page errors while typing, the
preview frozen on the last good value), and Enter closed the picker having silently written
nothing. `-3000y` gave a negative day. Seen in e2e probe output: `C: props
[{"scheduled":"1202-60-91"}]`, `B: errors ["RangeError: Invalid time value", …]`.

**Fixed 2026-09-13.** `parse.ts` checks an offset's result with `isValidJournalDay` and says
`"+10000y" is too far away` otherwise (`+7973y` still reaches 9999); `formatStoredDate` throws a
`RangeError` rather than format a day that is not on the calendar, so no caller can store one;
the picker's arrows/PageUp/PageDown stop at the calendar's ends. All three tests failed before the
fix (the component test also with two unhandled `RangeError`s).

---

### B-146 · `nooklet serve --help` ignores `--help` and serves the owner's real graph — migrating it and rewriting its mirror
**Status:** open · **Severity:** high (data safety; every agent on this machine is told never to
open `~/.nooklet/default`) · **Found:** 2026-09-13, verify-impl-dates — by doing it, by accident ·
**Test:** none yet

`pnpm nooklet serve --help`, run to read the flags, printed no usage: `cli-args.ts#parseArgs`
turns `--help` into an ordinary flag nothing reads, `cli.ts` only prints usage for a top-level
`help`/`--help`, and `serve` with no `--data` falls back to `$NOOKLET_DATA`, then
`~/.nooklet/default`. It opened the owner's graph with `migrate: true` and the live mirror on, and
listened on port 6100 until killed (~10 minutes later).

What it changed in `~/.nooklet/default`, measured against a `sqlite3 .backup` taken 33 s before it
started (09:19:07; server wrote from 09:19:40): `schema_migration` 1 → 3 rows (migrations "derive
page_alias … (B-55)" and "add idempotency … (B-58)" applied), `page_alias` 0 → 3 rows, `setting`
+1 row (`refs.pipe_alias`), `mirror_file` 0 → 952 rows, and all 952 `journals/*.md` +
`pages/*.md` files rewritten (mtime 09:19:41). `block`, `page`, `op`, `block_prop`, `page_prop`,
`ref`, `device`, `token`, `changes` are byte-identical to the backup (row dumps hashed). The
mirror is derived from the DB (never read back), so the rewrite loses nothing the DB holds; what
the files said before is not recoverable here. The pre-incident DB copy was kept at
`<verify scratch>/graph/graph.sqlite` (session scratch, not durable).

Fix direction (not done — `cli.ts` is shared): `--help` / `-h` on any subcommand prints that
command's usage and exits 0 before `open()`; arguably unknown flags should be an error for writers.

---

### B-147 · Text that reaches the page before the picker is listening, or without a keydown, goes into the block behind it
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verify-impl-dates · **Test:** none;
measured with throwaway Playwright probes (numbers below)

Two ways the picker's "keys never reach the block" rule has a hole, both because the editor keeps
DOM focus and the picker takes keys from a window `keydown` listener:

1. **Type-ahead.** `open()` reads the block (`getBlockTaskState`, a replica query) and lazy-loads
   `DatePicker.js` before the listener exists. Enter on the slash menu → picker mounted measured
   25 / 10 / 7 ms on the e2e graph and 6–24 ms (8 opens) on a copy of the owner's graph. A key
   pressed inside that window lands in the block: `" /sched"`, Enter, `tom` typed at once gave
   the block `fast typist t` and a picker holding `om` (invalid, so Enter only showed an error).
   Human keystrokes after Enter are normally slower than the gap, hence low.
2. **No keydown.** Text committed by an IME, a dead-key composition, dictation or a virtual
   keyboard arrives as `beforeinput`/`input` with no `keydown` of its own. Emulated with
   Playwright's `keyboard.type("zítra ěščřžýáíé")` (non-US characters go through `insertText`):
   the picker saw `ztra`, the block got `íěščřžýáíé`. Unverified on a real keyboard: a Czech
   layout's number-row letters (ě š č ř ž ý á í é) should arrive as ordinary keydowns and work;
   letters built with a dead háček/čárka key (ď ť ň, most capitals) should not. The picker's
   vocabulary is English words and digits, so this mostly matters for junk landing in the block. `docs/progress/impl-dates.md` §5 already names the
   mobile half of this.

Fix direction: hold keys from the moment `open()` is called (a capture listener handed to the
picker, replayed on mount), and take `beforeinput` `insertText` while open. Not done here.
