/**
 * B-583: the journal calendar, moved from a full-width toggle inside `JournalStreamView.tsx` into
 * a small top-bar icon (next to `SyncIndicator`) that opens an anchored popover — the owner's own
 * words: "should be smaller, should be icon at the top bar next to cloud... should open a small
 * popup ideally distinguishing dates for which there is something in their journal pages."
 * Mirrors `live/ConsentBadge.tsx`'s shape most closely (also a top-bar icon toggling a compact
 * popover), not `SettingsPanel.tsx`'s full backdrop+modal — a calendar is a quick jump, not a
 * destination.
 *
 * Picking a day writes to `app/journal-nav.ts`'s shared pinned-day signal and navigates to
 * `/journals` if not already there — `JournalStreamView.tsx` reads that signal instead of owning
 * pin state itself now that the trigger lives outside it.
 */
import { todayJournalDay } from "@nooklet/core";
import { useLocation, useNavigate } from "@solidjs/router";
import CalendarIcon from "lucide-solid/icons/calendar";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { pinJournalDay } from "../app/journal-nav.js";
import { useJournalDaysWithContent } from "../data/store.js";
import { Calendar, monthRange } from "../views/Calendar.js";
import "./calendar-button.css";

export function CalendarButton(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  const today = todayJournalDay();
  const [monthAnchor, setMonthAnchor] = createSignal(today);
  const [range, setRange] = createSignal(monthRange(today));
  const daysWithContent = useJournalDaysWithContent(
    () => range()[0],
    () => range()[1],
  );

  function onMonthChange(anchor: number): void {
    setMonthAnchor(anchor);
    setRange(monthRange(anchor));
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  function selectDay(day: number): void {
    pinJournalDay(day, today);
    setOpen(false);
    // `.endsWith`, not `!==`: `location.pathname` may carry this page's own /g/<slug> prefix
    // (ADR 025), which the app-relative "/journals" here never does.
    if (!location.pathname.endsWith("/journals")) navigate("/journals");
  }

  return (
    <div class="calendar-button-wrap">
      <button
        type="button"
        class="app-icon-button"
        aria-label="Calendar"
        title="Jump to a day"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarIcon size={17} />
      </button>
      <Show when={open()}>
        <div class="calendar-button-popover" role="dialog" aria-label="Jump to a day">
          <Calendar
            compact
            selected={monthAnchor()}
            daysWithContent={daysWithContent()}
            onMonthChange={onMonthChange}
            onSelect={selectDay}
          />
        </div>
      </Show>
    </div>
  );
}
