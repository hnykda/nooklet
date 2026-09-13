/** E.2 Tasks (category `Task`) — R34-R39. */
import type { TaskMarker } from "@nooklet/core";
import type { BlockPropsWrite, Command, CommandContext } from "../types.js";
import type { DatePickerHost } from "./date-picker-host.js";
import { completeTask, nextCycleMarker } from "./task-logic.js";

/** "the focused block (`editorFocused`) or the anchor of the selection (`blockSelected`)"
 * (R34/R37/R38 etc.). `CommandContext` doesn't expose the anchor separately from the selected-ids
 * array, so the first selected id stands in for it. */
function targetBlockId(ctx: CommandContext): string | null {
  return ctx.focusedBlockId ?? ctx.selectedBlockIds[0] ?? null;
}

/** The blocks a marker command writes: the focused block, or EVERY selected block. Only the first
 * selected one used to be marked, and the rest of the selection silently kept its marker (B-346). */
function targetBlockIds(ctx: CommandContext): string[] {
  return ctx.focusedBlockId ? [ctx.focusedBlockId] : ctx.selectedBlockIds;
}

/** R35's completion patch for one block, from its current state. */
async function completionPatch(
  ctx: CommandContext,
  blockId: string,
): Promise<Record<string, string | null>> {
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
  return patch;
}

async function applyCompletion(ctx: CommandContext, blockId: string): Promise<void> {
  await ctx.store.setBlockProps(blockId, await completionPatch(ctx, blockId));
}

type SerialRun = (run: (ctx: CommandContext) => Promise<void>) => Command["run"];

/**
 * Runs the task commands one after another. `task.cycle` and its kin READ the marker, then write
 * the next one, and the dispatcher does not wait for a command before running the next key
 * (`keymap/dispatch.ts#runRow`). Two Cmd/Ctrl+Enter back to back both read the marker before the
 * first write landed, both wrote `TODO`, and the second press was lost (B-282). Queued, the second
 * reads after the first has committed: the tree's `applyOps` posts the write to the DB worker
 * before the store's next query is posted, and the worker answers them in that order.
 */
function createSerialRun(): SerialRun {
  let tail: Promise<void> = Promise.resolve();
  return (run) => (ctx) => {
    const next = tail.then(() => run(ctx));
    // A command that throws must not stall every later one.
    tail = next.catch(() => {});
    return next;
  };
}

function setMarker(serial: SerialRun, id: string, title: string, marker: TaskMarker): Command {
  return {
    id,
    title,
    category: "Task",
    defaultKeys: {},
    when: "editorFocused || blockSelected",
    run: serial(async (ctx) => {
      // R39: a plain marker write, no `done` stamping — only reaching DONE goes through R35.
      // Every selected block in ONE write, so one Cmd/Ctrl+Z takes the command back (B-346).
      await ctx.store.setPropsOfBlocks(
        targetBlockIds(ctx).map((blockId) => ({ blockId, props: { marker } })),
      );
    }),
  };
}

/** R38. No argument (keyboard, palette, slash menu): open the picker. An argument (an agent via
 * `ui_run`, ADR 015 — nobody is there to answer a picker): a date string the picker would accept,
 * or `null` / `{ date: null }` to clear, written directly. */
async function runDateCommand(
  ctx: CommandContext,
  picker: DatePickerHost,
  field: "scheduled" | "deadline",
): Promise<void> {
  const blockId = targetBlockId(ctx);
  if (!blockId) return;
  const args = ctx.args;
  if (args === undefined) {
    picker.open({ blockId, field });
    return;
  }
  const input =
    args !== null && typeof args === "object" && "date" in args
      ? (args as { date: unknown }).date
      : args;
  if (input !== null && typeof input !== "string") {
    throw new Error(`${field}: expected a date string or null`);
  }
  await picker.set({ blockId, field, input });
}

export function createTaskCommands(deps: { datePicker: DatePickerHost }): Command[] {
  const serial = createSerialRun();
  return [
    {
      id: "task.cycle",
      title: "Cycle task marker",
      category: "Task",
      defaultKeys: { mac: "Cmd+Enter", other: "Ctrl+Enter" },
      when: "editorFocused || (blockSelected && selectionCount == 1)",
      run: serial(async (ctx) => {
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
      }),
    },
    {
      id: "task.toggleDone",
      title: "Toggle done",
      category: "Task",
      defaultKeys: {},
      when: "isTask",
      run: serial(async (ctx) => {
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
      }),
    },
    setMarker(serial, "task.setMarkerTodo", "Mark TODO", "TODO"),
    setMarker(serial, "task.setMarkerDoing", "Mark DOING", "DOING"),
    setMarker(serial, "task.setMarkerWaiting", "Mark WAITING", "WAITING"),
    setMarker(serial, "task.setMarkerCanceled", "Mark CANCELED", "CANCELED"),
    {
      id: "task.setMarkerDone",
      title: "Mark DONE",
      category: "Task",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      run: serial(async (ctx) => {
        // R39: repeat-aware, unlike the other five — each block from its own dates, all of them in
        // one write so one Cmd/Ctrl+Z takes the command back (B-346).
        const writes: BlockPropsWrite[] = [];
        for (const blockId of targetBlockIds(ctx)) {
          writes.push({ blockId, props: await completionPatch(ctx, blockId) });
        }
        await ctx.store.setPropsOfBlocks(writes);
      }),
    },
    {
      id: "task.clearMarker",
      title: "Clear task marker",
      category: "Task",
      defaultKeys: {},
      // `isTask` is read from the EDITED block only (a selection leaves it false), so without
      // `blockSelected` no selection was ever offered this command (B-346).
      when: "isTask || blockSelected",
      run: serial(async (ctx) => {
        // R39: leaves priority/scheduled/deadline/repeat/done untouched. Only blocks that have a
        // marker are written, so the undo step holds nothing that did not change.
        const writes: BlockPropsWrite[] = [];
        for (const blockId of targetBlockIds(ctx)) {
          const snapshot = await ctx.store.getBlockTaskState(blockId);
          if (snapshot?.marker) writes.push({ blockId, props: { marker: null } });
        }
        await ctx.store.setPropsOfBlocks(writes);
      }),
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
      // One picker for one block (`targetBlockId`): offered for a multi-selection it dated the
      // first block and silently left the rest (B-345).
      when: "editorFocused || (blockSelected && selectionCount == 1)",
      run(ctx) {
        return runDateCommand(ctx, deps.datePicker, "scheduled");
      },
    },
    {
      id: "task.setDeadline",
      title: "Set deadline date",
      category: "Task",
      defaultKeys: {},
      // One block only, like `task.setScheduled` (B-345).
      when: "editorFocused || (blockSelected && selectionCount == 1)",
      run(ctx) {
        return runDateCommand(ctx, deps.datePicker, "deadline");
      },
    },
  ];
}
