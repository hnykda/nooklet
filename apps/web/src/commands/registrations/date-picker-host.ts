/**
 * `task.setScheduled`/`task.setDeadline` (R38) open a date-picker popup (calendar grid, "Add
 * time"/"Repeat" toggles) anchored at the caret/row. Building that calendar-grid UI is out of
 * this pass's scope (see the summary's list of trims) — the commands below register the correct
 * id/title/category/`when` and delegate opening the picker to this narrow host, so the palette,
 * slash menu ("Scheduled"/"Deadline" items), and keymap all already work end-to-end once a real
 * `DatePickerHost` (and its UI) exists; only the picker's own implementation is left.
 */
export interface DatePickerHost {
  open(opts: { blockId: string; field: "scheduled" | "deadline" }): void;
}

export function createFakeDatePickerHost(): DatePickerHost & {
  calls: Array<{ blockId: string; field: "scheduled" | "deadline" }>;
} {
  const calls: Array<{ blockId: string; field: "scheduled" | "deadline" }> = [];
  return {
    calls,
    open(opts) {
      calls.push(opts);
    },
  };
}
