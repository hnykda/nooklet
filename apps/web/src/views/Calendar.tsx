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
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function startOfMonth(day: number): number {
  return Math.floor(day / 100) * 100 + 1;
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

  return (
    <div class="calendar">
      <div class="calendar-header">
        <button
          type="button"
          class="calendar-nav"
          aria-label="Previous month"
          onClick={() => setMonthAnchor((m) => addMonths(m, -1))}
        >
          ‹
        </button>
        <span class="calendar-month-label">{monthLabel()}</span>
        <button
          type="button"
          class="calendar-nav"
          aria-label="Next month"
          onClick={() => setMonthAnchor((m) => addMonths(m, 1))}
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
