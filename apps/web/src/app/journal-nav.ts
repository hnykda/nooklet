/**
 * The journal stream's "pinned day" (a day jumped to via the calendar, shown promoted into the
 * stream until it is Today — see `views/JournalStreamView.tsx`'s own comment on why a pin expires
 * at midnight, B-177) as a module-singleton signal rather than `JournalStreamView`'s local state.
 *
 * Needed because the calendar trigger moved out of the journal view and into the top bar
 * (`shell/CalendarButton.tsx`, B-583) — a sibling of `JournalStreamView` under the router, not a
 * parent, so there is no prop to pass the selection through. Same module-singleton shape this
 * package already uses for cross-component state with no natural prop path (`live/consent.ts`,
 * `live/connection-state.ts`).
 */
import { createSignal } from "solid-js";

const [pinnedJournalDay, setPinnedJournalDaySignal] = createSignal<number | undefined>(undefined);

export { pinnedJournalDay };

/** Pin `day` into the stream — unless it's Today, which the stream already shows and never pins
 * (mirrors `JournalStreamView`'s pre-B-583 inline logic exactly). */
export function pinJournalDay(day: number, today: number): void {
  setPinnedJournalDaySignal(day === today ? undefined : day);
}

export function clearPinnedJournalDay(): void {
  setPinnedJournalDaySignal(undefined);
}
