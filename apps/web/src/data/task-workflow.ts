/**
 * Where the graph's task workflow comes from (B-608). The value itself is the signal in
 * `commands/task-workflow.ts`; this file decides it, in this order:
 *
 *   1. The reader's choice in Settings, kept per graph in localStorage. Per device, like the
 *      journal title format (ADR 018): `setting` writes have no op kind to sync through yet
 *      (sql-schema.md rule 25).
 *   2. The server's suggestion from `/api/session`: the graph's imported `:preferred-workflow`,
 *      else inferred from its markers (`packages/server/src/task-workflow.ts`).
 *   3. Offline with no suggestion: the same inference over the local replica.
 *
 * Without 2/3 a graph like the owner's (72 LATER, 5 NOW, 0 TODO) cycled a LATER task to no marker
 * and started every new task as TODO.
 */

import { inferTaskWorkflow, parseTaskWorkflow, type TaskWorkflow } from "@nooklet/core";
import { setActiveTaskWorkflow, taskWorkflow } from "../commands/task-workflow.js";
import { queryAs } from "../db/client.js";
import { activeGraphId } from "./bootstrap.js";

const STORAGE_PREFIX = "nooklet.taskWorkflow";

function storageKey(): string {
  const id = activeGraphId();
  return id ? `${STORAGE_PREFIX}.${id}` : STORAGE_PREFIX;
}

function storedChoice(): TaskWorkflow | null {
  try {
    return parseTaskWorkflow(localStorage.getItem(storageKey()));
  } catch {
    return null; // Private browsing, or storage disabled.
  }
}

/** Reactive; re-exported so views need not know the signal lives with the commands. */
export { taskWorkflow };

/** Whether the current value is the reader's own choice rather than a suggestion. */
export function taskWorkflowIsChosen(): boolean {
  return storedChoice() !== null;
}

/** The Settings picker. Takes effect immediately, for every surface. */
export function chooseTaskWorkflow(value: TaskWorkflow): void {
  setActiveTaskWorkflow(value);
  try {
    localStorage.setItem(storageKey(), value);
  } catch {
    // Lost on reload; not worth surfacing.
  }
}

async function inferLocally(): Promise<TaskWorkflow> {
  const rows = await queryAs<{ marker: string; n: number }>(
    `SELECT marker, COUNT(*) AS n FROM block
     WHERE deleted_at IS NULL AND marker IN ('TODO','DOING','LATER','NOW')
     GROUP BY marker`,
  );
  let laterNow = 0;
  let todoDoing = 0;
  for (const r of rows) {
    if (r.marker === "LATER" || r.marker === "NOW") laterNow += Number(r.n);
    else todoDoing += Number(r.n);
  }
  return inferTaskWorkflow({ laterNow, todoDoing });
}

/**
 * Called once at startup with `BootstrapConfig.taskWorkflow`. Synchronous for 1 and 2, so the very
 * first Mod+Enter already follows the graph; 3 settles a moment later, once the replica answers.
 */
export function initTaskWorkflow(suggestion: string | undefined): void {
  const chosen = storedChoice();
  if (chosen) {
    setActiveTaskWorkflow(chosen);
    return;
  }
  const suggested = parseTaskWorkflow(suggestion);
  if (suggested) {
    setActiveTaskWorkflow(suggested);
    return;
  }
  void inferLocally()
    .then((inferred) => {
      // A choice made in Settings while the query ran wins.
      if (storedChoice() === null) setActiveTaskWorkflow(inferred);
    })
    .catch(() => {
      // No replica yet: keep the default.
    });
}
