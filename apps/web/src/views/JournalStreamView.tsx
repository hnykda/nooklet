/**
 * The journal stream (BUILD item 1; PLAN.md §8): today always at the top (virtual until it has a
 * block, `VirtualJournalDay.tsx`), then earlier non-empty days below, infinite-scrolling, plus a
 * calendar to jump to any day. This is the default route (`/journals`) and, per research/08 §3,
 * the primary phone surface — kept usable one-handed: the calendar is collapsed by default, "load
 * more" happens automatically near the bottom of the scroll (no precise tapping required).
 */
import { formatJournalTitle } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { useAgendaTasks } from "../data/agenda.js";
import { journalTitleFormat } from "../data/page-title.js";
import { useJournalStream, usePinnedJournalDay } from "../data/store.js";
import type { JournalDayEntry, NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { Calendar } from "./Calendar.js";
import { JournalAgenda } from "./JournalAgenda.js";
import { goToTarget } from "./navigateTarget.js";
import { createStreamToday } from "./streamToday.js";
import { VirtualJournalDay } from "./VirtualJournalDay.js";

const INITIAL_MAX_DAYS = 14;
const LOAD_MORE_STEP = 14;

/** The reader's chosen date format (ADR 018) — this stream is where they see it most, so it was
 *  the most visible place hard-coded ISO was wrong. */
function dayTitle(day: number): string {
  return formatJournalTitle(day, journalTitleFormat());
}

export function JournalStreamView(): JSX.Element {
  const navigate = useNavigate();
  const onNavigate = (t: NavigateTarget) => void goToTarget(navigate, t);

  let root: HTMLDivElement | undefined;
  // Follows the local day, so a tab left open overnight moves on to the new day (B-170).
  const today = createStreamToday(() => root);
  const [maxDays, setMaxDays] = createSignal(INITIAL_MAX_DAYS);
  const [calendarOpen, setCalendarOpen] = createSignal(false);
  const [pinnedDay, setPinnedDay] = createSignal<number | undefined>(undefined);

  const stream = useJournalStream(() => ({ today: today(), maxDays: maxDays() }));
  const pinned = usePinnedJournalDay(pinnedDay);
  // One read for every day's "Scheduled and deadline" section, however many days are loaded.
  const agenda = useAgendaTasks();
  const agendaFor = (day: number) => (
    <JournalAgenda day={day} today={today()} tasks={agenda} onNavigate={onNavigate} />
  );

  // The stream's own today entry — real (page/blocks already exist) or virtual (`page: null`,
  // PLAN.md §8). `stream()` always includes today (`worker-core.ts#getJournalStream`), so this is
  // only ever `undefined` for one frame while the resource is first loading.
  const todayEntry = createMemo<JournalDayEntry | undefined>(() =>
    stream()?.find((e) => e.day === today()),
  );

  // Journal days AHEAD of today, rendered above it so the whole stream reads newest-first. These
  // exist only because something was deliberately written or scheduled there, so unlike empty past
  // days they are never hidden (`worker-core.ts#getJournalStream`).
  const laterDays = createMemo<JournalDayEntry[]>(() => {
    const all = stream() ?? [];
    return all.filter((e) => e.day > today() && e.day !== pinnedDay());
  });

  // "Earlier non-empty days" per PLAN.md §8, minus the pinned day if the calendar jump duplicates
  // one already in that window.
  const earlierDays = createMemo<JournalDayEntry[]>(() => {
    const all = stream() ?? [];
    return all.filter((e) => e.day < today() && e.day !== pinnedDay());
  });

  let sentinel: HTMLDivElement | undefined;
  onMount(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setMaxDays((n) => n + LOAD_MORE_STEP);
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="journal-stream" ref={root}>
      <div class="journal-stream-toolbar">
        <button
          type="button"
          class="journal-calendar-toggle"
          onClick={() => setCalendarOpen((v) => !v)}
        >
          {calendarOpen() ? "Hide calendar" : "Calendar"}
        </button>
      </div>
      <Show when={calendarOpen()}>
        <Calendar
          selected={pinnedDay() ?? today()}
          onSelect={(day) => {
            setPinnedDay(day === today() ? undefined : day);
            setCalendarOpen(false);
          }}
        />
      </Show>

      <For each={laterDays()}>
        {(entry) => (
          <section class="journal-day journal-day-upcoming" aria-label={dayTitle(entry.day)}>
            <h2 class="journal-day-title">{dayTitle(entry.day)} · Upcoming</h2>
            <Show when={entry.page}>
              {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
            </Show>
            {agendaFor(entry.day)}
          </section>
        )}
      </For>

      <section class="journal-day journal-day-today" aria-label="Today">
        <h2 class="journal-day-title">{dayTitle(today())} · Today</h2>
        <Show
          when={todayEntry()?.page}
          fallback={<VirtualJournalDay day={today()} onNavigate={onNavigate} />}
        >
          {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
        </Show>
        {agendaFor(today())}
      </section>

      <Show when={pinned() && pinnedDay() !== undefined}>
        <section class="journal-day journal-day-pinned" aria-label="Jumped-to day">
          <h2 class="journal-day-title">
            {dayTitle(pinnedDay() as number)}
            <button type="button" class="journal-day-unpin" onClick={() => setPinnedDay(undefined)}>
              Back to stream
            </button>
          </h2>
          <Show
            when={pinned()?.page}
            fallback={<VirtualJournalDay day={pinnedDay() as number} onNavigate={onNavigate} />}
          >
            {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
          </Show>
          {agendaFor(pinnedDay() as number)}
        </section>
      </Show>

      <For each={earlierDays()}>
        {(entry) => (
          <section class="journal-day" aria-label={dayTitle(entry.day)}>
            <h2 class="journal-day-title">{dayTitle(entry.day)}</h2>
            <Show when={entry.page}>
              {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
            </Show>
            {agendaFor(entry.day)}
          </section>
        )}
      </For>

      <div ref={sentinel} class="journal-stream-sentinel" aria-hidden="true" />
    </div>
  );
}
