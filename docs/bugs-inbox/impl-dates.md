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
