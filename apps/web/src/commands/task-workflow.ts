/**
 * The active graph's task workflow (B-608), as a signal every task surface reads synchronously:
 * the editor's Mod+Enter (`editor/task.ts`), the registry's `task.*` commands, the slash menu's
 * task rows. Only state lives here; where the value comes from (the reader's choice, the graph's
 * imported `:preferred-workflow`, or the markers it actually uses) is `data/task-workflow.ts`.
 *
 * Starts at `todo` — nooklet's behaviour before the setting existed — until that module resolves.
 */
import type { TaskWorkflow } from "@nooklet/core";
import { createSignal } from "solid-js";

const [workflow, setWorkflow] = createSignal<TaskWorkflow>("todo");

/** Reactive. */
export const taskWorkflow = workflow;

export function setActiveTaskWorkflow(value: TaskWorkflow): void {
  setWorkflow(value);
}
