/**
 * A calendar control to jump to any day (BUILD item 1; PLAN.md §8: "A calendar opens any day as a
 * virtual page"). Selecting a day that has no journal page yet is fine — it just doesn't persist
 * until something is written to it (the caller, `JournalStreamView.tsx`, decides what "open a day"
 * means; this component only picks a `YYYYMMDD` integer).
 */
import { dateToJournalDay, journalDayToDate, todayJournalDay } from "@nooklet/core";
import { createMemo, createSignal, For, type JSX } from "solid-js";

export interface CalendarProps {
  /** Highlighted as "selected" (e.g. the day currently at the top of the stream); optional. */
  selected?: number;
  onSelect: (day: number) => void;
  /** B-583: days (as `YYYYMMDD` integers) that have at least one live block — marked with a small
   * dot so a reader can tell an empty day from one worth opening before clicking through. Omit to
   * render with no dots at all (a resource that hasn't answered yet, say), not a broken state. */
  daysWithContent?: Set<number>;
  /** B-583: the compact size used in `shell/CalendarButton.tsx`'s top-bar popover — smaller cells,
   * tighter padding. The full-size grid stays available for anywhere the extra room is welcome. */
  compact?: boolean;
  /** Called whenever the visible month changes (paging with ‹ ›), so a caller sourcing
   * `daysWithContent` for "the visible month" knows when to refetch. */
  onMonthChange?: (monthAnchor: number) => void;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function startOfMonth(day: number): number {
  return Math.floor(day / 100) * 100 + 1;
}

/** B-583: the first/last `YYYYMMDD` of the month containing `monthAnchor` — exported so a caller
 * sourcing `daysWithContent` (`shell/CalendarButton.tsx`) can ask for exactly the visible month,
 * without duplicating this arithmetic. */
export function monthRange(monthAnchor: number): [first: number, last: number] {
  const first = journalDayToDate(startOfMonth(monthAnchor));
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const last = dateToJournalDay(new Date(first.getFullYear(), first.getMonth(), daysInMonth));
  return [startOfMonth(monthAnchor), last];
}

function addMonths(day: number, delta: number): number {
  const d = journalDayToDate(startOfMonth(day));
  d.setMonth(d.getMonth() + delta);
  return dateToJournalDay(d);
}

/** Every day cell for the month containing `monthAnchor`, padded to whole weeks (Monday-first)
 * with `null` for the leading/trailing days of adjacent months. */
function monthGrid(monthAnchor: number): Array<number | null> {
  const first = journalDayToDate(startOfMonth(monthAnchor));
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  // getDay(): 0=Sunday..6=Saturday; convert to Monday-first (0=Monday..6=Sunday).
  const leadingBlanks = (first.getDay() + 6) % 7;
  const cells: Array<number | null> = Array.from({ length: leadingBlanks }, () => null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(dateToJournalDay(new Date(first.getFullYear(), first.getMonth(), d)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function Calendar(props: CalendarProps): JSX.Element {
  const today = todayJournalDay();
  const [monthAnchor, setMonthAnchor] = createSignal(props.selected ?? today);
  const cells = createMemo(() => monthGrid(monthAnchor()));
  const monthLabel = createMemo(() =>
    journalDayToDate(startOfMonth(monthAnchor())).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  );

  function changeMonth(delta: number): void {
    setMonthAnchor((m) => {
      const next = addMonths(m, delta);
      props.onMonthChange?.(next);
      return next;
    });
  }

  return (
    <div class="calendar" classList={{ "calendar-compact": props.compact }}>
      <div class="calendar-header">
        <button
          type="button"
          class="calendar-nav"
          aria-label="Previous month"
          onClick={() => changeMonth(-1)}
        >
          ‹
        </button>
        <span class="calendar-month-label">{monthLabel()}</span>
        <button
          type="button"
          class="calendar-nav"
          aria-label="Next month"
          onClick={() => changeMonth(1)}
        >
          ›
        </button>
      </div>
      <div class="calendar-weekdays">
        <For each={WEEKDAY_LABELS}>{(label) => <span>{label}</span>}</For>
      </div>
      <div class="calendar-grid">
        <For each={cells()}>
          {(day) => (
            <button
              type="button"
              class="calendar-day"
              classList={{
                "calendar-day-empty": day === null,
                "calendar-day-today": day === today,
                "calendar-day-selected": day !== null && day === props.selected,
                "calendar-day-has-content":
                  day !== null && (props.daysWithContent?.has(day) ?? false),
              }}
              disabled={day === null}
              onClick={() => day !== null && props.onSelect(day)}
            >
              {day !== null ? day % 100 : ""}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
