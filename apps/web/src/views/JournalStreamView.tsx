/**
 * The journal stream (BUILD item 1; PLAN.md §8): today always at the top (virtual until it has a
 * block, `VirtualJournalDay.tsx`), then earlier non-empty days below, infinite-scrolling. This is
 * the default route (`/journals`) and, per research/08 §3, the primary phone surface.
 *
 * B-583: the calendar used to be an inline toggle+grid at the top of this view; it now lives in
 * the top bar (`shell/CalendarButton.tsx`), so picking a day writes to `app/journal-nav.ts`'s
 * shared signal instead of local state — this view just reads it.
 */
import { formatJournalTitle } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { clearPinnedJournalDay, pinnedJournalDay } from "../app/journal-nav.js";
import { useAgendaTasks } from "../data/agenda.js";
import { journalTitleFormat } from "../data/page-title.js";
import { useJournalStream, usePinnedJournalDay } from "../data/store.js";
import type { JournalDayEntry, NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { JournalAgenda } from "./JournalAgenda.js";
import { JournalDayOutline } from "./JournalDayOutline.js";
import { goToTarget } from "./navigateTarget.js";
import { createStreamToday } from "./streamToday.js";

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
  // B-583: the day picked from `shell/CalendarButton.tsx`'s top-bar popover — shared state, since
  // the trigger is no longer a child of this view (`app/journal-nav.ts`).
  const pinnedDay = pinnedJournalDay;

  // A pin is "a day other than Today" (the calendar never pins today itself), but Today moves at
  // midnight: a day pinned late the evening before would then be rendered twice — two editable
  // outlines of one page, one above the other (B-177). Once Today catches up, the pin is spent.
  createEffect(() => {
    if (untrack(pinnedDay) === today()) clearPinnedJournalDay();
  });

  const stream = useJournalStream(() => ({ today: today(), maxDays: maxDays() }));
  const pinned = usePinnedJournalDay(pinnedDay);
  // One read for every day's "Scheduled and deadline" section, however many days are loaded.
  const agenda = useAgendaTasks();
  const agendaFor = (day: number) => (
    <JournalAgenda day={day} today={today()} tasks={agenda} onNavigate={onNavigate} />
  );

  // The stream's own today entry — real (page/blocks already exist) or virtual (`page: null`,
  // PLAN.md §8). `stream()` always includes today (`worker-core.ts#getJournalStream`), so this is
  // `undefined` only while the resource is first loading — which on a fresh client is not one
  // frame but the whole first sync, because every worker call waits for it (B-410).
  const todayEntry = createMemo<JournalDayEntry | undefined>(() =>
    stream()?.find((e) => e.day === today()),
  );

  const entryByDay = createMemo(
    () => new Map<number, JournalDayEntry>((stream() ?? []).map((e) => [e.day, e])),
  );

  // The lists below are DAY NUMBERS, never `JournalDayEntry` objects. `<For>` is keyed by
  // reference, and every write refetches the stream into brand-new entry objects — so iterating
  // entries tore down and rebuilt every day section, with its `BlockTree` and the editor inside
  // it, on each debounced keystroke write: typing in any day below Today dropped out of editing
  // half a second in (B-174). Numbers compare by value, so a section lives as long as its day is
  // in the stream, and reads its entry through `entryByDay`.
  const days = (keep: (day: number) => boolean) =>
    createMemo<number[]>(() => [...entryByDay().keys()].filter(keep), [], {
      equals: (a, b) => a.length === b.length && a.every((d, i) => d === b[i]),
    });

  // Journal days AHEAD of today, rendered above it so the whole stream reads newest-first. These
  // exist only because something was deliberately written or scheduled there, so unlike empty past
  // days they are never hidden (`worker-core.ts#getJournalStream`).
  const laterDays = days((d) => d > today() && d !== pinnedDay());

  // "Earlier non-empty days" per PLAN.md §8, minus the pinned day if the calendar jump duplicates
  // one already in that window.
  const earlierDays = days((d) => d < today() && d !== pinnedDay());

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
      <For each={laterDays()}>
        {(day) => (
          <section class="journal-day journal-day-upcoming" aria-label={dayTitle(day)}>
            <h2 class="journal-day-title">{dayTitle(day)} · Upcoming</h2>
            <Show when={entryByDay().get(day)?.page}>
              {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
            </Show>
            {agendaFor(day)}
          </section>
        )}
      </For>

      <section class="journal-day journal-day-today" aria-label="Today">
        <h2 class="journal-day-title">{dayTitle(today())} · Today</h2>
        {/* Keyed by day: a day started from its draft keeps its own tree (B-411), which must not
            carry over to the next day at midnight. */}
        <Show when={today()} keyed>
          {(day) => <JournalDayOutline day={day} entry={todayEntry()} onNavigate={onNavigate} />}
        </Show>
        {agendaFor(today())}
      </section>

      <Show when={pinned() && pinnedDay() !== undefined}>
        <section class="journal-day journal-day-pinned" aria-label="Jumped-to day">
          <h2 class="journal-day-title">
            {dayTitle(pinnedDay() as number)}
            <button type="button" class="journal-day-unpin" onClick={() => clearPinnedJournalDay()}>
              Back to stream
            </button>
          </h2>
          <Show when={pinnedDay()} keyed>
            {(day) => (
              <JournalDayOutline
                day={day}
                // While a new pin loads, the resource still holds the previous day's entry.
                entry={pinned()?.day === day ? pinned() : undefined}
                onNavigate={onNavigate}
              />
            )}
          </Show>
          {agendaFor(pinnedDay() as number)}
        </section>
      </Show>

      <For each={earlierDays()}>
        {(day) => (
          <section class="journal-day" aria-label={dayTitle(day)}>
            <h2 class="journal-day-title">{dayTitle(day)}</h2>
            <Show when={entryByDay().get(day)?.page}>
              {(page) => <BlockTree pageId={page().id} onNavigate={onNavigate} />}
            </Show>
            {agendaFor(day)}
          </section>
        )}
      </For>

      <div ref={sentinel} class="journal-stream-sentinel" aria-hidden="true" />
    </div>
  );
}
