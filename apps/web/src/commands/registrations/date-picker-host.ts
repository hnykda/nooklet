/**
 * The seam `task.setScheduled` / `task.setDeadline` (R38) delegate to.
 *
 * `open` shows the date picker for a block and writes whatever is chosen; `set` writes a typed
 * value directly with no UI — what an agent passes through `ui_run` (ADR 015), where a picker
 * would be a question nobody is there to answer. The real implementation is
 * `../date-picker/host.ts`; this package's tests use the fake below.
 *
 * History: until 2026-09-13 the app itself was handed `createFakeDatePickerHost()`, so the slash
 * items, the palette rows and the commands all "worked" and nothing happened (B-96).
 */
export type DatePickerField = "scheduled" | "deadline";

export interface DatePickerHost {
  /** Open the picker for `blockId`. Returns once the picker is being OPENED — not when it closes —
   * so a caller that awaits the command (the slash menu awaits `exec` before it dismisses itself)
   * is not held on screen for the whole pick. */
  open(opts: {
    blockId: string;
    field: DatePickerField;
    /** Viewport point to open at; defaults to under the caret, else under the block's row. */
    anchor?: { top: number; left: number };
  }): void;
  /** Write `input` without a picker: anything the picker's text field accepts (`tomorrow`,
   * `+3d`, `2026-09-20 14:00`, `none`), or `null` to clear. Rejects on text that is not a date. */
  set(opts: { blockId: string; field: DatePickerField; input: string | null }): Promise<void>;
}

export function createFakeDatePickerHost(): DatePickerHost & {
  calls: Array<{ blockId: string; field: DatePickerField }>;
  sets: Array<{ blockId: string; field: DatePickerField; input: string | null }>;
} {
  const calls: Array<{ blockId: string; field: DatePickerField }> = [];
  const sets: Array<{ blockId: string; field: DatePickerField; input: string | null }> = [];
  return {
    calls,
    sets,
    open(opts) {
      calls.push({ blockId: opts.blockId, field: opts.field });
    },
    async set(opts) {
      sets.push(opts);
    },
  };
}
