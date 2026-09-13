/**
 * The real `DatePickerHost` (B-96): read the block's current dates, ask the picker, write the
 * answer as `block.prop` ops through the command `Store` — the same seam every other task command
 * writes through, so the reducer's ADR 011 validation is the only judge of the stored value.
 *
 * Host-agnostic like the rest of `commands/`: the picker UI is an injectable `pick` (the default
 * loads `DatePicker.tsx` on first use, so this module evaluates without a DOM and its tests run in
 * plain Node), and `today` is injectable so a test can pin the calendar.
 */
import { type JournalDay, todayJournalDay } from "@nooklet/core";
import type { DatePickerField, DatePickerHost } from "../registrations/date-picker-host.js";
import type { BlockTaskSnapshot, Store } from "../types.js";
import { formatStoredDate, parseDateInput, parseStoredDate } from "./parse.js";

export interface DatePickRequest {
  blockId: string;
  field: DatePickerField;
  /** The block's current value for `field`, if it has one. */
  current: { day: JournalDay; time: string | null } | undefined;
  /** The block's current `repeat::`, shared by both fields (ADR 011). */
  repeat: string | null;
  today: JournalDay;
  anchor: { top: number; left: number } | undefined;
}

/** What the person chose. On `set`, an absent `repeat` leaves the block's repeat alone and `null`
 * removes it. */
export type DatePickResult =
  | { kind: "set"; day: JournalDay; time: string | null; repeat?: string | null }
  | { kind: "clear" };

export interface DatePickerHostDeps {
  store: Store;
  /** Show the picker; resolve with the choice, or `undefined` on cancel. */
  pick?: (req: DatePickRequest) => Promise<DatePickResult | undefined>;
  today?: () => JournalDay;
  /** Where a failed write is reported. A pick completes long after the command that opened it
   * has returned, so there is no caller left to reject to. */
  onError?: (error: unknown) => void;
}

async function defaultPick(req: DatePickRequest): Promise<DatePickResult | undefined> {
  const { openDatePicker } = await import("./DatePicker.js");
  return new Promise((resolve) => {
    openDatePicker({ ...req, onPick: resolve, onCancel: () => resolve(undefined) });
  });
}

/** The `block.prop` patch a pick amounts to. Exported for tests: this is the whole contract. */
export function patchForPick(
  field: DatePickerField,
  snapshot: BlockTaskSnapshot | undefined,
  result: DatePickResult,
): Record<string, string | null> {
  const currentRepeat = snapshot?.repeat ?? null;
  if (result.kind === "clear") {
    const patch: Record<string, string | null> = { [field]: null };
    // A repeat with no date left to shift is a stale instruction waiting to surprise someone the
    // next time a date is set; while the other field still has a date, the repeat is still live.
    const other = field === "scheduled" ? "deadline" : "scheduled";
    if (!snapshot?.[other] && currentRepeat !== null) patch.repeat = null;
    return patch;
  }
  const patch: Record<string, string | null> = {
    [field]: formatStoredDate(result.day, result.time),
  };
  if (result.repeat !== undefined && result.repeat !== currentRepeat) patch.repeat = result.repeat;
  return patch;
}

export function createDatePickerHost(deps: DatePickerHostDeps): DatePickerHost {
  const pick = deps.pick ?? defaultPick;
  const today = deps.today ?? (() => todayJournalDay());
  const onError = deps.onError ?? ((e: unknown) => console.error("date picker:", e));

  async function write(
    blockId: string,
    field: DatePickerField,
    snapshot: BlockTaskSnapshot | undefined,
    result: DatePickResult,
  ): Promise<void> {
    // One batch: a new date and its repeat must not be observable half-applied.
    await deps.store.setBlockProps(blockId, patchForPick(field, snapshot, result));
  }

  return {
    open({ blockId, field, anchor }) {
      // Deliberately not returned to the command: the pick is a person's decision and can take a
      // minute, and the slash menu stays mounted until the command it ran settles.
      void (async () => {
        const snapshot = await deps.store.getBlockTaskState(blockId);
        const result = await pick({
          blockId,
          field,
          current: parseStoredDate(snapshot?.[field]),
          repeat: snapshot?.repeat ?? null,
          today: today(),
          anchor,
        });
        if (!result) return;
        // Re-read: the block may have changed while the picker was open (another device, an
        // agent), and the repeat rule must judge the block as it is now.
        await write(blockId, field, await deps.store.getBlockTaskState(blockId), result);
      })().catch(onError);
    },

    async set({ blockId, field, input }) {
      const snapshot = await deps.store.getBlockTaskState(blockId);
      if (input === null) {
        await write(blockId, field, snapshot, { kind: "clear" });
        return;
      }
      const parsed = parseDateInput(input, today());
      if (parsed.kind === "invalid") throw new Error(parsed.message);
      if (parsed.kind === "empty") throw new Error("no date given — pass a date, or null to clear");
      if (parsed.kind === "clear") {
        await write(blockId, field, snapshot, { kind: "clear" });
        return;
      }
      const current = parseStoredDate(snapshot?.[field]);
      const { parts } = parsed;
      await write(blockId, field, snapshot, {
        kind: "set",
        day: parts.day ?? current?.day ?? today(),
        time: parts.time !== undefined ? parts.time : (current?.time ?? null),
        ...(parts.repeat !== undefined ? { repeat: parts.repeat } : {}),
      });
    },
  };
}
