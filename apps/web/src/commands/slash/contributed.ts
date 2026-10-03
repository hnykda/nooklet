/**
 * Slash-menu rows contributed at runtime — today only by client plugins (`registerSlashCommand`,
 * ADR 023) — appended after the core list (`./items.ts`). Each row names a command like a core row
 * does, so selecting it goes through the same `exec` and the same registry (R1: nothing bypasses
 * the registry); the contributor registers that command itself.
 *
 * A signal, not a plain array: the menu's ranking memo must re-run when a plugin finishes
 * activating after the menu module has loaded, or the row never appears. `SlashMenu` used to rank a
 * module-level constant, which is half of why `/mermaid` was dead (B-103).
 */
import { createSignal } from "solid-js";
import { taskWorkflow } from "../task-workflow.js";
import type { SlashItem } from "../types.js";
import { slashItemsFor } from "./items.js";

const [contributed, setContributed] = createSignal<readonly SlashItem[]>([]);

/** Add a row; the returned function removes exactly that row. */
export function contributeSlashItem(item: SlashItem): () => void {
  setContributed((rows) => [...rows, item]);
  return () => setContributed((rows) => rows.filter((r) => r !== item));
}

/** Core rows (ordered for the graph's task workflow, B-608), then contributed rows, in
 * registration order. Tracked. */
export function slashItems(): readonly SlashItem[] {
  const core = slashItemsFor(taskWorkflow());
  const extra = contributed();
  return extra.length === 0 ? core : [...core, ...extra];
}
