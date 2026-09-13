/**
 * A block's scheduled/deadline dates as chips at the end of its row (B-102). Clicking one opens
 * the same date picker `/scheduled` does, anchored under the chip.
 *
 * Rendered by `BlockRowView` for every row with a date, task or not, and while the row is being
 * edited too — so setting a date from the slash menu shows up at once, next to the caret that
 * asked for it. The chip is a button that refuses focus on `mousedown`, like the marker button:
 * a click on it must not take the caret out of the block being edited.
 */
import { type JournalDay, todayJournalDay } from "@nooklet/core";
// One file per icon, not the `lucide-solid` barrel: this module sits under every rendered row,
// and the barrel re-exports 1,821 icon modules (lucide-solid 1.44) — importing it made anything
// that renders a row (the query fence's lazy view in `render-seams.test.tsx`) take over five
// seconds to load under vitest, which unbundled imports every one of them.
import CalendarClock from "lucide-solid/icons/calendar-clock";
import Flag from "lucide-solid/icons/flag";
import Repeat from "lucide-solid/icons/repeat";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { dateChips } from "./date-chips.js";
import "./date-chips.css";

// "Today" is a signal, not a read at render time: a page left open overnight has to turn
// yesterday's "Today" chip into an overdue one without anyone touching the block. One timer for
// the whole app, re-armed at each local midnight, plus a check whenever the tab becomes visible
// again (timers are throttled — or frozen — in a background tab).
const [today, setToday] = createSignal<JournalDay>(todayJournalDay());
let ticking = false;
function watchToday(): void {
  if (ticking || typeof window === "undefined") return;
  ticking = true;
  const refresh = (): void => {
    const now = todayJournalDay();
    if (now !== today()) setToday(now);
  };
  const arm = (): void => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    setTimeout(() => {
      refresh();
      arm();
    }, next.getTime() - now.getTime());
  };
  arm();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

export function DateChips(props: {
  blockId: string;
  scheduled: string | null;
  deadline: string | null;
  marker: string | null;
  repeat: string | null;
}): JSX.Element {
  watchToday();
  const chips = createMemo(() =>
    dateChips(
      { scheduled: props.scheduled, deadline: props.deadline, marker: props.marker },
      today(),
    ),
  );

  return (
    <Show when={chips().length > 0}>
      <span class="vr-dates">
        <For each={chips()}>
          {(chip, i) => (
            <button
              type="button"
              class={`vr-date vr-date-${chip.field} vr-date-${chip.tone}`}
              data-field={chip.field}
              data-value={chip.value}
              title={props.repeat ? `${chip.title} (repeats ${props.repeat})` : chip.title}
              aria-label={chip.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                // The row's own click handler would enter edit mode at the click offset.
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                // Imported on click, not at the top: `BlockRowView` (and through it the shelf and
                // the query fence, which borrow `MARKER_GLYPH`) must not drag the data layer —
                // `app/hosts.ts`, the replica client — into everything that renders a row. The app
                // bundle already holds the module (`CommandLayer` imports it), so this resolves
                // in a microtask.
                const anchor = { top: rect.bottom + 4, left: rect.left };
                void import("../app/date-picker.js").then(({ blockDatePicker }) =>
                  blockDatePicker.open({ blockId: props.blockId, field: chip.field, anchor }),
                );
              }}
            >
              <Show when={chip.field === "scheduled"} fallback={<Flag size={11} aria-hidden />}>
                <CalendarClock size={11} aria-hidden />
              </Show>
              <span class="vr-date-label">{chip.label}</span>
              <Show when={props.repeat && i() === 0}>
                <Repeat size={10} aria-hidden class="vr-date-repeat" />
              </Show>
            </button>
          )}
        </For>
      </span>
    </Show>
  );
}
