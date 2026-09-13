/**
 * A journal day's "Scheduled and deadline" section (PLAN.md §8): under the day's own blocks, the
 * open tasks from elsewhere in the graph that are scheduled for or due on that day — and, on
 * today, everything overdue. Read-only: a glance at what is due, not a second place to edit it;
 * a click goes to the task (zoomed in on its page) and the group heading goes to the page.
 * Renders nothing at all when there is nothing to list.
 *
 * Which tasks, and in what order, is `./agendaDay.ts`; where they come from is
 * `../data/agenda.ts` — one read shared by every day the journal stream shows, handed in as
 * `tasks`.
 */

import { formatJournalTitle } from "@nooklet/core";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { AgendaTask } from "../data/agenda.js";
import { displayPageName, journalTitleFormat } from "../data/page-title.js";
import type { NavigateTarget } from "../data/types.js";
import { MARKER_GLYPH } from "../editor/BlockRowView.js";
import { InlineContent } from "../editor/InlineContent.js";
import { type AgendaDate, type AgendaEntry, agendaForDay } from "./agendaDay.js";
import { pageRoutePath } from "./navigateTarget.js";
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
    e.preventDefault();
    props.onNavigate({ kind: "block", id: props.entry.task.id });
  };
  return (
    <li class="journal-agenda-item" data-block-id={props.entry.task.id}>
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
        <span
          class={`vr-marker vr-marker-${props.entry.task.marker}`}
          role="img"
          aria-label={`Task: ${props.entry.task.marker}`}
        >
          {MARKER_GLYPH[props.entry.task.marker] ?? "☐"}
        </span>
        <Show when={props.entry.task.priority}>
          {(p) => <span class={`vr-priority vr-priority-${p()}`}>{p()}</span>}
        </Show>
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

export function JournalAgenda(props: JournalAgendaProps): JSX.Element {
  const groups = createMemo(() =>
    props.tasks.error ? [] : agendaForDay(props.tasks(), props.day, props.today),
  );
  return (
    <Show when={groups().length > 0}>
      <div class="journal-agenda" data-day={props.day}>
        <h3 class="journal-agenda-title">Scheduled and deadline</h3>
        <For each={groups()}>
          {(group) => (
            <div class="journal-agenda-group" data-page-id={group.pageId}>
              <a
                class="journal-agenda-page"
                href={pageRoutePath(group.pageName)}
                onClick={(e) => {
                  e.preventDefault();
                  props.onNavigate({ kind: "page", name: group.pageName });
                }}
              >
                {displayPageName({ name: group.pageName, journalDay: group.pageJournalDay })}
              </a>
              <ul class="journal-agenda-list">
                <For each={group.entries}>
                  {(entry) => <EntryRow entry={entry} onNavigate={props.onNavigate} />}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
