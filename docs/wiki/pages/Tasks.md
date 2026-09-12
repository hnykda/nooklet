type:: guide
summary:: Markers, cycling, priorities, scheduled and deadline dates with repeats, and the Tasks view.
tags:: guide

- A block is a task when its first word is a marker. Type the marker, pick "TODO / task" from the slash menu, or press Cmd/Ctrl+Enter on the block.
- ## Markers
  - `TODO` ☐ · `DOING` ◐ · `DONE` ☑ · `WAITING` ◔ · `CANCELED` ☒. Each state has its own glyph so a list scans without reading (`MARKER_GLYPH` in `apps/web/src/editor/BlockRowView.tsx`).
  - `LATER` and `NOW` — Logseq's other workflow — are markers too, rendered ☐ and ◐. They are kept as written: `docs/PLAN.md` §5 says NOW/LATER are "mapped to TODO/DOING" on import, but `packages/core` keeps them as distinct markers (`TASK_MARKERS` in `model.ts`, the marker regex in `outline.ts`). The code wins; both count as open in the Tasks view.
  - Import tolerance: `WAIT` becomes `WAITING`, `CANCELLED` becomes `CANCELED`, `IN-PROGRESS` becomes `DOING`.
  - Every task references a `Task` page automatically — derived from the marker, never written into your text — so `Task`'s linked references are every task in the graph.
- ## Cycling
  - Cmd/Ctrl+Enter: none → TODO → DOING → DONE → none. From any other state (WAITING, CANCELED, LATER, NOW, and DONE) the cycle goes to none. `WAITING` and `CANCELED` are set from the palette, the block's context menu or the slash menu (`Mark WAITING`, `Mark CANCELED`) and are never reached by cycling.
  - The checkbox on a rendered task toggles done: DONE → TODO (whatever the state was before), any other open state → DONE. A canceled task has no checkbox.
  - Reaching DONE stamps `done::` with the completion time (ISO 8601 UTC). Clearing the marker leaves `priority`, `scheduled`, `deadline`, `repeat` and `done` alone, so putting a marker back restores the schedule.
- ## Priority
  - `[#A]`, `[#B]` or `[#C]` after the marker. Set from the palette (`Set priority A/B/C`); parsed for Logseq compatibility and shown as a small badge. No shortcut, no sorting by it.
- ## Scheduled and deadline
  - Typed properties, not org-mode lines (ADR 011): `scheduled:: 2026-09-12`, `deadline:: 2026-09-14 14:00` — ISO date, optional 24-hour time, no weekday, no angle brackets.
  - Set them with `/scheduled` and `/deadline` from the slash menu, which open a date picker, or type the property line under the block.
  - `repeat:: 1w` moves the date forward from the scheduled/deadline date when the task is completed; `repeat:: 1w from done` moves it from the completion time. Units are `d`, `w`, `m`, `y`; months and years use calendar arithmetic (the 10th again, not +30 days). Completing a repeating task advances its dates, stamps `done::`, and sets the marker back to `TODO` rather than `DONE`.
  - Logseq's `SCHEDULED: <2026-09-12 Sat .+1w>` and `DEADLINE:` lines are read on import and become these properties; org's three repeater spellings (`+1w`, `++1w`, `.+1w`) all become `repeat:: 1w`. Nothing writes org syntax back. See [[Import from Logseq]].
  - There is no `:LOGBOOK:`. When a task changed state is answered by the op log — every marker change is an op with a timestamp and actor — not by text in the block.
- ## The Tasks view
  - `/tasks` (sidebar → Tasks): open tasks grouped by page, sorted by due date. Filters: state (TODO, DOING, LATER, NOW, WAITING), a tag, a namespace, and a due-from/due-to window. The checkbox completes a task in place; the text opens the block zoomed in its page.
  - Over the API and MCP the same question is `search` with a `properties` filter such as `{"marker": "TODO"}`; there is no separate tasks tool. See [[Agents and MCP]].
- Related: [[Journals]] (the per-day "Scheduled and deadline" section is planned, not built), [[Keyboard shortcuts]], [[Markdown format]].
