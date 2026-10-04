# M8 · impl-dates — progress log

Agent task: make dates work end to end. B-96 (`/scheduled`, `/deadline`, "Set scheduled/deadline
date" do nothing — the real command set was handed `createFakeDatePickerHost()`), exposure audit
§2 item 3 (a real, keyboard-first date picker), B-102 / audit §2 item 2 (scheduled/deadline
chips on the row, overdue styled, click opens the picker). Syntax is ADR 011 (`scheduled::
YYYY-MM-DD[ HH:MM]`, `repeat:: 1w[ from done]`), picker behaviour is
`docs/spec/commands-and-keymap.md` R38.

Branch `m8/impl-dates`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-8`,
started from `61279a2` (the worktree was created at an older commit, `f7c9644`; the fresh branch
was reset to `61279a2` before any work). e2e port 6400. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-dates/`.

## 1. Done (commit hashes)

- `f6b6059` `commands/date-picker/parse.ts` (+test): typed-date vocabulary → ADR 011 parts.
- `0674645` picker + host + chips, unit/component tested:
  - `commands/date-picker/host.ts` — real `DatePickerHost` (`open` → pick → one
    `setBlockProps` batch; `set` for agents, no UI); `patchForPick` is the write contract.
  - `commands/date-picker/DatePicker.tsx` + `date-picker.css` — the popup.
  - `commands/registrations/date-picker-host.ts` — interface gains `set` and `anchor`; fake
    records both. `task.ts` — `runDateCommand`: no args → open, string/`{date}`/null → set.
  - `app/date-picker.ts` — the one shared host instance; `app/CommandLayer.tsx` uses it (the
    B-96 fix, 3 lines).
  - `editor/date-chips.ts` (pure label/tone) + `editor/DateChips.tsx` + `date-chips.css`;
    `editor/BlockRowView.tsx` hookup (import + 7-line JSX).
- `7f7cf45` `e2e/tests/dates.spec.ts` (6 tests), inbox B-96/B-102/B-140, this file.
- `db1f068` B-141 (stale error line in the picker, a Solid `<Match>` render-callback trap) +
  picker width/wrap after a light/dark/400px screenshot review.
- `8a563fc` B-142 logged (open): a picked date is not undoable; probe
  `tools/probes/picked-date-undo.spec.ts`.
- `3a27081` B-143 fixed in `packages/core/src/outline.ts`: Logseq's `SCHEDULED: <2023-2-17 Fri>`
  (one-digit month/day/hour) was imported as text, losing 20 of the owner's 24 scheduled dates.
  Tests: `packages/core/src/outline-org-dates.test.ts`, importer test in `logseq.test.ts`.
  Grammar spec OUT-23 updated. Real import re-run: 24 scheduled (was 4), 0 leftovers, verify OK.
- `1a61255` spec R38 "as built" paragraph; `tools/probes/date-chips-real-graph.mjs` (19 chips
  on the owner's 2023-02-17 journal, picker opens on that day, no errors).

## 2. In flight

Nothing uncommitted.

## 3. Next steps, in order

Task complete on this branch. Final numbers (2026-09-13 ~08:50):
- e2e on 6400, 14 specs (dates, popups, tasks, selection, templates, query, shelf, context-menu,
  phone, focus, editing, views, journals, rendering): 189 passed, 1 skipped (pre-existing skip in
  context-menu.spec.ts:200), 0 failed.
- Unit: core 336/336, plugin-api 17/17, server 522/522; apps/web 720/720 on the last 3
  consecutive runs (earlier runs hit the B-144 load flakes — also present without this branch).
- `pnpm -r typecheck` clean. `pnpm nooklet verify` on a fresh import of the real Logseq graph: OK.

Left for later / other owners: B-142 (undo of store-routed task commands, needs a seam in
`BlockTree.tsx`), the journal-day "Scheduled and deadline" section (audit §2 #1), repairing the
20 already-imported blocks in the owner's live graph (B-143; re-import or a one-off fix).

## 4. Decisions (and why)

- **Editor keeps focus; keys taken at the WINDOW capture phase.** Like `TemplatePicker` the
  popup is not focusable, so Escape/Enter leave the caret exactly where it was. But
  `TemplatePicker` listens on `document`, where `CommandLayer`'s global dispatcher (registered
  first) runs before it; in block selection that made Backspace delete the selected block.
  Verified by mutation: swapping the listener to `document` failed e2e test 6 with the first
  block deleted.
- **Typed vocabulary instead of R38's "Add time" / "Repeat" toggles.** `fri 14:00`,
  `every 2w from done`, `no time`, `no repeat`, `none` — keyboard-first, as asked, and no extra
  controls. The grid, month nav, Today/Tomorrow/Next week and Remove buttons cover the mouse.
- **Weekday names mean the next one strictly after today** ("today" is spelled `today`);
  `next week`/`next month` mean what the `[[` date shortcuts mean (Monday of next ISO week, 1st
  of next month). A yearless date already behind today rolls to next year.
- **Chips on every block with a date, task or not**; overdue styling only on open tasks (red on
  a plain note would be an alarm about nothing); closed tasks muted.
- **Clearing the last remaining date also removes `repeat`**; clearing one of two keeps it.
- **Commands take an argument** (`"tomorrow"`, `{date: null}`) and write without a picker — an
  agent through `ui_run` has nobody to answer a picker (ADR 015).
- **Icons by path, data layer on click** in `DateChips.tsx` — see B-140.
- e2e test 1 uses a plain block, not a TODO: `query.spec.ts` counts open tasks scheduled for
  tomorrow in the shared e2e graph.

## 5. Known limits (not done)

- A date set through the picker is not on the editor's undo stack — verified by probe, logged as
  B-142 (open). The same gap in the other `ctx.store` task commands is by code reading only.
- `biome check apps/web/src/editor/BlockRowView.tsx` reports one `noStaticElementInteractions`
  error on the row `<div onContextMenu>` — pre-existing at `61279a2` (checked in the main
  checkout), not touched here.
- Mobile/IME: a virtual keyboard that sends `beforeinput` without real `keydown`s would type into
  the block rather than the picker. The grid and buttons work by touch. Not tested on a device.
- The journal day "Scheduled and deadline" section (audit §2 #1) is a different item — not
  started here.

## 6. How to resume

`git switch m8/impl-dates` in the worktree above; read §3; run
`pnpm --filter @nooklet/web test` and
`cd e2e && NOOKLET_E2E_PORT=6400 pnpm exec playwright test tests/dates.spec.ts --project=chromium`.
