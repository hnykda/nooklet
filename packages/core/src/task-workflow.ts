/**
 * Logseq's `:preferred-workflow` (B-608): `now` (LATER → NOW → DONE) or `todo` (TODO → DOING →
 * DONE). Pure, shared by the editor's Mod+Enter, the command registry, the server's session
 * bootstrap and the importer, so every path agrees on what a "new task" is.
 *
 * Semantics copied from Logseq 0.10.9 (file graphs), `frontend/util/marker.cljs#cycle-marker-state`
 * and `frontend/handler/editor.cljs#uncheck` / `#update-timestamps-content!` — see
 * `docs/progress/tasks-workflow.md` for the quotes. The point that is easy to get wrong: the cycle
 * is keyed on the CURRENT marker, not on the workflow. A TODO block under `now` still goes to
 * DOING, a LATER block under `todo` still goes to NOW; only where a cycle *starts* depends on it.
 */
import type { TaskMarker } from "./model.js";

export type TaskWorkflow = "now" | "todo";

export const TASK_WORKFLOWS: readonly TaskWorkflow[] = ["now", "todo"];

/** The marker a plain block (or a checkbox un-tick) becomes: `LATER` under `now`, else `TODO`. */
export function workflowStartMarker(workflow: TaskWorkflow): "LATER" | "TODO" {
  return workflow === "now" ? "LATER" : "TODO";
}

/** The marker after the start one: `NOW` under `now`, else `DOING`. */
export function workflowActiveMarker(workflow: TaskWorkflow): "NOW" | "DOING" {
  return workflow === "now" ? "NOW" : "DOING";
}

/**
 * Mod+Enter: `TODO→DOING→DONE`, `LATER→NOW→DONE`, `DONE→none`; none and every other marker
 * (WAITING, CANCELED) → the workflow's start marker. A `DONE` result must be routed through the
 * repeat-aware completion rule (R35) by the caller.
 */
export function cycleTaskMarker(
  current: TaskMarker | null,
  workflow: TaskWorkflow,
): TaskMarker | null {
  switch (current) {
    case "TODO":
      return "DOING";
    case "DOING":
      return "DONE";
    case "LATER":
      return "NOW";
    case "NOW":
      return "DONE";
    case "DONE":
      return null;
    default:
      return workflowStartMarker(workflow);
  }
}

/**
 * The marker a *repeating* task reopens with once completed (R35): Logseq maps `NOW→LATER` and
 * `DOING→TODO` and keeps any other marker. nooklet keeps the open marker of the task's own
 * workflow pair: LATER/NOW → LATER, everything else → TODO (as before B-608).
 */
export function repeatReopenMarker(previous: TaskMarker | null): "LATER" | "TODO" {
  return previous === "LATER" || previous === "NOW" ? "LATER" : "TODO";
}

/**
 * Logseq's reading of a `:preferred-workflow` value (`state.cljs#get-preferred-workflow`):
 * anything containing `now`/`NOW` is `now`, any other value is `todo`. Leading `:` (EDN keyword)
 * is accepted. Empty / non-string → `null` (no setting).
 */
export function parseTaskWorkflow(value: unknown): TaskWorkflow | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^:/, "");
  if (v === "") return null;
  return /now|NOW/.test(v) ? "now" : "todo";
}

/**
 * A graph with no explicit setting: whichever pair it actually uses. More LATER+NOW than
 * TODO+DOING → `now`; otherwise (including an empty graph) `todo`. Logseq's own default when the
 * key is absent is `now`, but a graph nooklet created never had the key, and its blocks are the
 * better evidence; an empty one keeps nooklet's long-standing TODO start.
 */
export function inferTaskWorkflow(counts: { laterNow: number; todoDoing: number }): TaskWorkflow {
  return counts.laterNow > counts.todoDoing ? "now" : "todo";
}
