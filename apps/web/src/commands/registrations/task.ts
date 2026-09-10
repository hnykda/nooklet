/** E.2 Tasks (category `Task`) — R34-R39. */
import type { TaskMarker } from "@nooklet/core";
import type { Command, CommandContext } from "../types.js";
import type { DatePickerHost } from "./date-picker-host.js";
import { completeTask, nextCycleMarker } from "./task-logic.js";

/** "the focused block (`editorFocused`) or the anchor of the selection (`blockSelected`)"
 * (R34/R37/R38 etc.). `CommandContext` doesn't expose the anchor separately from the selected-ids
 * array, so the first selected id stands in for it. */
function targetBlockId(ctx: CommandContext): string | null {
  return ctx.focusedBlockId ?? ctx.selectedBlockIds[0] ?? null;
}

async function applyCompletion(ctx: CommandContext, blockId: string): Promise<void> {
  const snapshot = await ctx.store.getBlockTaskState(blockId);
  const result = completeTask({
    marker: snapshot?.marker ?? null,
    scheduled: snapshot?.scheduled,
    deadline: snapshot?.deadline,
    repeat: snapshot?.repeat,
  });
  const patch: Record<string, string | null> = { marker: result.marker, done: result.done };
  if (result.scheduled !== undefined) patch.scheduled = result.scheduled;
  if (result.deadline !== undefined) patch.deadline = result.deadline;
  await ctx.store.setBlockProps(blockId, patch);
}

function setMarker(id: string, title: string, marker: TaskMarker): Command {
  return {
    id,
    title,
    category: "Task",
    defaultKeys: {},
    when: "editorFocused || blockSelected",
    async run(ctx) {
      const blockId = targetBlockId(ctx);
      if (!blockId) return;
      // R39: a plain marker write, no `done` stamping — only reaching DONE goes through R35.
      await ctx.store.setBlockProp(blockId, "marker", marker);
    },
  };
}

export function createTaskCommands(deps: { datePicker: DatePickerHost }): Command[] {
  return [
    {
      id: "task.cycle",
      title: "Cycle task marker",
      category: "Task",
      defaultKeys: { mac: "Cmd+Enter", other: "Ctrl+Enter" },
      when: "editorFocused || (blockSelected && selectionCount == 1)",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (!blockId) return;
        const snapshot = await ctx.store.getBlockTaskState(blockId);
        const current = snapshot?.marker ?? null;
        if (current === "DOING") {
          // R34: the DOING -> DONE step is repeat-aware (R35).
          await applyCompletion(ctx, blockId);
          return;
        }
        const next = nextCycleMarker(current);
        await ctx.store.setBlockProp(blockId, "marker", next);
      },
    },
    {
      id: "task.toggleDone",
      title: "Toggle done",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (!blockId) return;
        const snapshot = await ctx.store.getBlockTaskState(blockId);
        if (snapshot?.marker === "DONE") {
          // R36: does not restore whatever pre-DONE state it had.
          await ctx.store.setBlockProp(blockId, "marker", "TODO");
          return;
        }
        // marker is TODO/DOING/WAITING (isTask excludes null); CANCELED is left as-is by a
        // checkbox click per R36, but toggleDone's `when` doesn't exclude it structurally — a
        // real checkbox simply isn't rendered for a canceled task, so this path is unreached in
        // practice; defensively no-op rather than "completing" a canceled task.
        if (snapshot?.marker === "CANCELED") return;
        await applyCompletion(ctx, blockId);
      },
    },
    setMarker("task.setMarkerTodo", "Mark TODO", "TODO"),
    setMarker("task.setMarkerDoing", "Mark DOING", "DOING"),
    setMarker("task.setMarkerWaiting", "Mark WAITING", "WAITING"),
    setMarker("task.setMarkerCanceled", "Mark CANCELED", "CANCELED"),
    {
      id: "task.setMarkerDone",
      title: "Mark DONE",
      category: "Task",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (!blockId) return;
        await applyCompletion(ctx, blockId); // R39: repeat-aware, unlike the other five.
      },
    },
    {
      id: "task.clearMarker",
      title: "Clear task marker",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (!blockId) return;
        // R39: leaves priority/scheduled/deadline/repeat/done untouched.
        await ctx.store.setBlockProp(blockId, "marker", null);
      },
    },
    {
      id: "task.setPriorityA",
      title: "Set priority A",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (blockId) await ctx.store.setBlockProp(blockId, "priority", "A");
      },
    },
    {
      id: "task.setPriorityB",
      title: "Set priority B",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (blockId) await ctx.store.setBlockProp(blockId, "priority", "B");
      },
    },
    {
      id: "task.setPriorityC",
      title: "Set priority C",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      async run(ctx) {
        const blockId = targetBlockId(ctx);
        if (blockId) await ctx.store.setBlockProp(blockId, "priority", "C");
      },
    },
    {
      id: "task.setScheduled",
      title: "Set scheduled date",
      category: "Task",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      run(ctx) {
        const blockId = targetBlockId(ctx);
        if (blockId) deps.datePicker.open({ blockId, field: "scheduled" });
      },
    },
    {
      id: "task.setDeadline",
      title: "Set deadline date",
      category: "Task",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      run(ctx) {
        const blockId = targetBlockId(ctx);
        if (blockId) deps.datePicker.open({ blockId, field: "deadline" });
      },
    },
  ];
}
