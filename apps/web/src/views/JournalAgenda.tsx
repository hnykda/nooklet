/**
 * A journal day's "Scheduled and deadline" section (PLAN.md §8): under the day's own blocks, the
 * open tasks and dated non-task blocks from elsewhere in the graph that are scheduled for or due on
 * that day — and, on today, every overdue task, the first ten shown and the rest behind "Show all
 * N overdue". Read-only: a glance at what is due, not a second place to edit it;
 * a click goes to the task (zoomed in on its page) and the group heading goes to the page.
 * Renders nothing at all when there is nothing to list.
 *
 * Which tasks, and in what order, is `./agendaDay.ts`; where they come from is
 * `../data/agenda.ts` — one read shared by every day the journal stream shows, handed in as
 * `tasks`.
 */

import { formatJournalTitle } from "@nooklet/core";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { AgendaTask } from "../data/agenda.js";
import { displayPageName, journalTitleFormat } from "../data/page-title.js";
import type { NavigateTarget } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import { TaskMarkerIcon } from "../editor/TaskMarkerIcon.js";
import { pageRoutePath, rawAnchorHref } from "../routes/page-path.js";
import {
  type AgendaDate,
  type AgendaEntry,
  type AgendaGroup,
  type AgendaSection,
  agendaSection,
  OVERDUE_SHOWN,
} from "./agendaDay.js";
import "./journal-agenda.css";

export interface JournalAgendaProps {
  /** The journal day this section belongs to (YYYYMMDD). */
  day: number;
  /** The local day now — overdue tasks are listed only when `day` is today. */
  today: number;
  /** `useAgendaTasks()`'s resource. Its `error` is checked before reading: reading an errored
   *  resource re-throws, and a failed read here must not take the whole journal stream down. */
  tasks: { (): readonly AgendaTask[]; error?: unknown };
  onNavigate: (t: NavigateTarget) => void;
}

function dateLabel(d: AgendaDate): string {
  const kind = d.kind === "scheduled" ? "Scheduled" : "Deadline";
  // On its own day the date is the section's day, so only the time adds anything; an overdue date
  // is the whole point of the chip.
  const when = d.overdue ? formatJournalTitle(d.day, journalTitleFormat()) : "";
  return [kind, when, d.time ?? ""].filter((s) => s !== "").join(" ");
}

function EntryRow(props: { entry: AgendaEntry; onNavigate: (t: NavigateTarget) => void }) {
  const go = (e: Event): void => {
    // A web link in the task's text has no click handler of its own (a [[page]] link does, and
    // stops the event): cancelling here would swallow "open in a new tab" and open the task
    // instead (B-175). Let the link have its click, or its Enter.
    const target = e.target instanceof Element ? e.target : null;
    const link = target?.closest("a[href]");
    if (link && (e.currentTarget as Element | null)?.contains(link)) return;
    e.preventDefault();
    props.onNavigate({ kind: "block", id: props.entry.task.id });
  };
  return (
    // Not `data-block-id`: that names the task's outliner row, and on the journal stream Today's
    // agenda comes before older days' rows, so a reveal or agent flash found this first (B-321).
    <li class="journal-agenda-item" data-agenda-block-id={props.entry.task.id}>
      {/* biome-ignore lint/a11y/useSemanticElements: the row navigates on click but hosts rendered rich content (links) that cannot live inside an <a>. */}
      <div
        class="journal-agenda-row"
        role="link"
        tabIndex={0}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e);
        }}
      >
        {/* Marker and priority share one grid cell, so the content column starts in the same place
            whether or not a task has a priority — and the dates can drop under it on a phone. */}
        <span class="journal-agenda-lead">
          <Show
            when={props.entry.task.marker}
            fallback={
              // A dated block that is not a task: the outliner's bullet, not an empty checkbox.
              <span class="journal-agenda-bullet" aria-hidden="true" />
            }
          >
            {(marker) => (
              <span
                class={`vr-marker vr-marker-${marker()}`}
                role="img"
                aria-label={`Task: ${marker()}`}
              >
                <TaskMarkerIcon marker={marker()} />
              </span>
            )}
          </Show>
          <Show when={props.entry.task.priority}>
            {(p) => <span class={`vr-priority vr-priority-${p()}`}>{p()}</span>}
          </Show>
        </span>
        <span class="journal-agenda-content" dir="auto">
          <InlineContent content={props.entry.task.content} onNavigate={props.onNavigate} />
        </span>
        <span class="journal-agenda-dates">
          <For each={props.entry.dates}>
            {(d) => (
              <span
                class={`journal-agenda-date journal-agenda-date-${d.kind}`}
                classList={{ "journal-agenda-date-overdue": d.overdue }}
              >
                {dateLabel(d)}
              </span>
            )}
          </For>
        </span>
      </div>
    </li>
  );
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** Same field values, one level deep. */
function shallowEqual<T extends object>(a: T, b: T): boolean {
  const ka = Object.keys(a) as (keyof T)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** An entry whose task and dates did not change: its row has nothing to re-render. */
const sameEntry = (a: AgendaEntry, b: AgendaEntry): boolean =>
  shallowEqual(a.task, b.task) &&
  a.dates.length === b.dates.length &&
  a.dates.every((d, i) => shallowEqual(d, b.dates[i] as AgendaDate));

const NOTHING: AgendaSection = { groups: [], overdue: 0, hidden: 0 };

export function JournalAgenda(props: JournalAgendaProps): JSX.Element {
  // Per section, not remembered: a day opened later starts collapsed again.
  const [showAllOverdue, setShowAllOverdue] = createSignal(false);
  const section = createMemo(() =>
    props.tasks.error
      ? NOTHING
      : agendaSection(props.tasks(), props.day, props.today, {
          overdueLimit: showAllOverdue() ? undefined : OVERDUE_SHOWN,
        }),
  );
  const groups = (): AgendaGroup[] => section().groups;
  // The lists below iterate KEYS — page ids, then task ids — never the group and entry objects.
  // Every write refetches the tasks and `agendaForDay` builds brand-new objects, and `<For>` is
  // keyed by reference: iterating objects tore down and rebuilt every row on every keystroke's
  // write anywhere in the graph, dropping keyboard focus or a text selection on a row (B-176, the
  // B-174 pattern). A row now lives as long as its task is listed, and reads its entry through a
  // map, so a changed task updates in place — and only a changed one: each row's entry is a memo
  // that ignores a refetch handing back the same values, or every row would re-render its text on
  // every write.
  const groupByPage = createMemo(() => new Map(groups().map((g) => [g.pageId, g])));
  const pageIds = createMemo(() => groups().map((g) => g.pageId), [], { equals: sameKeys });
  return (
    <Show when={pageIds().length > 0}>
      <div class="journal-agenda" data-day={props.day}>
        <h3 class="journal-agenda-title">Scheduled and deadline</h3>
        <For each={pageIds()}>
          {(pageId) => {
            // The last group seen for this key: a row can be asked once more while `<For>` is
            // removing it, after the map has already dropped its key.
            let lastGroup = groupByPage().get(pageId) as AgendaGroup;
            const group = (): AgendaGroup => {
              lastGroup = groupByPage().get(pageId) ?? lastGroup;
              return lastGroup;
            };
            const entryById = createMemo(() => new Map(group().entries.map((e) => [e.task.id, e])));
            const taskIds = createMemo(() => group().entries.map((e) => e.task.id), [], {
              equals: sameKeys,
            });
            const heading = createMemo(
              () => ({ name: group().pageName, journalDay: group().pageJournalDay }),
              undefined,
              { equals: shallowEqual },
            );
            return (
              <div class="journal-agenda-group" data-page-id={pageId}>
                <a
                  class="journal-agenda-page"
                  // ADR 025: a raw `<a>`, outside `@solidjs/router` — see `rawAnchorHref`'s doc.
                  href={rawAnchorHref(pageRoutePath(heading().name))}
                  onClick={(e) => {
                    e.preventDefault();
                    props.onNavigate({ kind: "page", name: heading().name });
                  }}
                >
                  {displayPageName(heading())}
                </a>
                <ul class="journal-agenda-list">
                  <For each={taskIds()}>
                    {(taskId) => {
                      let lastEntry = entryById().get(taskId) as AgendaEntry;
                      const entry = createMemo(
                        () => {
                          lastEntry = entryById().get(taskId) ?? lastEntry;
                          return lastEntry;
                        },
                        undefined,
                        { equals: sameEntry },
                      );
                      return <EntryRow entry={entry()} onNavigate={props.onNavigate} />;
                    }}
                  </For>
                </ul>
              </div>
            );
          }}
        </For>
        <Show when={section().overdue > OVERDUE_SHOWN}>
          <button
            type="button"
            class="journal-agenda-more"
            aria-expanded={showAllOverdue()}
            onClick={() => setShowAllOverdue((v) => !v)}
          >
            {showAllOverdue() ? "Show fewer overdue" : `Show all ${section().overdue} overdue`}
          </button>
        </Show>
      </div>
    </Show>
  );
}
