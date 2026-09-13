/**
 * Tasks view (BUILD item 5; PLAN.md §8): open tasks grouped by page, filterable by state/tag/
 * scheduled-deadline window, sorted by due date. Checkbox cycling reuses
 * `../editor/task.ts#toggleDone` — the exact same R35/R36-correct op-building function the real
 * block-level marker pill will call — so this "goes through the same op path as everywhere else"
 * by construction, not by convention.
 */
import type { TaskMarker } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { displayRefName } from "../data/page-title.js";
import { applyOps, getOpClock, useOpenTasks } from "../data/store.js";
import type { TaskRow } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import { toggleDone } from "../editor/task.js";
import type { EditableBlock } from "../editor/types.js";
import { pageRoutePath, pageZoomRoutePath } from "../routes/page-path.js";
import { goToTarget } from "./navigateTarget.js";
import {
  filterTasks,
  groupTasksByPage,
  OPEN_TASK_STATES,
  sortTasksByDue,
  type TaskFilters,
  taskDateLabels,
} from "./taskFilters.js";

function reconstructDate(day: number | null, time: string | null): string | null {
  if (day === null) return null;
  const s = String(day).padStart(8, "0");
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return time ? `${iso} ${time}` : iso;
}

/** Same conversion as `../editor/BlockTree.tsx`'s private `toEditableBlock`; duplicated (not
 * imported) because that one is a stub-internal detail, not a public export. */
function toEditableBlock(t: TaskRow): EditableBlock {
  return {
    id: t.id,
    parentId: t.parentId,
    order: t.order,
    content: t.content,
    marker: t.marker,
    priority: t.priority,
    collapsed: t.collapsed,
    scheduled: reconstructDate(t.scheduledDay, t.scheduledTime),
    deadline: reconstructDate(t.deadlineDay, t.deadlineTime),
    repeat: t.repeat,
    doneAt: t.doneAt,
    properties: {},
  };
}

export function TasksView(): JSX.Element {
  const navigate = useNavigate();
  const tasks = useOpenTasks();

  const [states, setStates] = createSignal<Set<TaskMarker>>(new Set(OPEN_TASK_STATES));
  const [tag, setTag] = createSignal("");
  const [namespace, setNamespace] = createSignal("");
  const [dueFrom, setDueFrom] = createSignal("");
  const [dueTo, setDueTo] = createSignal("");

  function toggleState(s: TaskMarker): void {
    setStates((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const filters = createMemo<TaskFilters>(() => ({
    states: [...states()],
    tag: tag().trim() || undefined,
    namespace: namespace().trim() || undefined,
    dueFrom: dueFrom() ? Number(dueFrom().replaceAll("-", "")) : undefined,
    dueTo: dueTo() ? Number(dueTo().replaceAll("-", "")) : undefined,
  }));

  const groups = createMemo(() =>
    groupTasksByPage(sortTasksByDue(filterTasks(tasks(), filters()))),
  );

  async function onToggle(t: TaskRow): Promise<void> {
    const clock = await getOpClock();
    await applyOps(toggleDone(toEditableBlock(t), clock));
  }

  return (
    <div class="tasks-view">
      <h1>Tasks</h1>

      <div class="task-filters">
        <fieldset class="task-state-filters">
          <legend>State</legend>
          <For each={OPEN_TASK_STATES}>
            {(s) => (
              <label class="task-state-checkbox">
                <input type="checkbox" checked={states().has(s)} onChange={() => toggleState(s)} />
                {s}
              </label>
            )}
          </For>
        </fieldset>
        <label>
          Tag
          <input
            value={tag()}
            onInput={(e) => setTag(e.currentTarget.value)}
            placeholder="e.g. launch"
          />
        </label>
        <label>
          Namespace
          <input
            value={namespace()}
            onInput={(e) => setNamespace(e.currentTarget.value)}
            placeholder="e.g. Projects"
          />
        </label>
        <label>
          Due from
          <input type="date" value={dueFrom()} onInput={(e) => setDueFrom(e.currentTarget.value)} />
        </label>
        <label>
          Due to
          <input type="date" value={dueTo()} onInput={(e) => setDueTo(e.currentTarget.value)} />
        </label>
      </div>

      <Show when={tasks.loading && tasks() === undefined}>
        <p>Loading…</p>
      </Show>
      <Show when={tasks() !== undefined && groups().length === 0}>
        <p class="tasks-empty">No open tasks match these filters.</p>
      </Show>

      <For each={groups()}>
        {(group) => (
          <section class="task-group">
            <h2>
              <button
                type="button"
                class="task-group-page"
                onClick={() => navigate(pageRoutePath(group.pageName))}
              >
                {displayRefName(group.pageName)}
              </button>
            </h2>
            <ul class="task-list">
              <For each={group.tasks}>
                {(t) => (
                  <li class="task-row">
                    <button
                      type="button"
                      class="task-checkbox"
                      aria-label={t.marker === "DONE" ? "Mark not done" : "Mark done"}
                      classList={{ checked: t.marker === "DONE" }}
                      onClick={() => void onToggle(t)}
                    >
                      {t.marker === "DONE" ? "☑" : "☐"}
                    </button>
                    <button
                      type="button"
                      class="task-content"
                      onClick={() => navigate(pageZoomRoutePath(group.pageName, t.id))}
                    >
                      <InlineContent
                        content={t.content}
                        onNavigate={(target) => void goToTarget(navigate, target)}
                      />
                    </button>
                    <Show when={taskDateLabels(t).length > 0}>
                      <span class="task-due">
                        <For each={taskDateLabels(t)}>
                          {(d) => <span class={`task-date task-date-${d.kind}`}>{d.label}</span>}
                        </For>
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>
    </div>
  );
}
