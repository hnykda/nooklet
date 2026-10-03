/**
 * The graph's task workflow (B-608): Logseq's `:preferred-workflow`, `now` (LATER → NOW → DONE)
 * or `todo` (TODO → DOING → DONE).
 *
 * Kept exactly like the journal title format (`journal-format.ts`, ADR 018): a graph-level
 * *suggestion* the importer records from `config.edn`, handed to clients by `/api/session`; the
 * reader's explicit choice in Settings is a client-side preference that wins over it. Not a synced
 * setting, because `setting` writes have no op kind yet (sql-schema.md rule 25).
 *
 * A graph with no recorded value — created in nooklet, or imported before this existed (the
 * owner's) — is answered from its markers: more LATER+NOW than TODO+DOING means `now`.
 */

import {
  inferTaskWorkflow,
  parseTaskWorkflow,
  type SqlDriver,
  type TaskWorkflow,
} from "@nooklet/core";

const KEY = "task.preferred_workflow";

/** The workflow recorded for this graph (imported from `config.edn`), or `null`. */
export function recordedTaskWorkflow(driver: SqlDriver): TaskWorkflow | null {
  const row = driver.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = ?", [
    KEY,
  ]);
  if (!row) return null;
  try {
    return parseTaskWorkflow(JSON.parse(row.value_json) as unknown);
  } catch {
    return null;
  }
}

export function setRecordedTaskWorkflow(driver: SqlDriver, workflow: TaskWorkflow): void {
  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc)
     VALUES (?, 'default', ?, ?, '')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(workflow), Date.now()],
  );
}

/** Which pair the graph's live blocks actually use. One indexed-or-not GROUP BY over `block`;
 * called once per `/api/session`, i.e. once per app load. */
export function inferredTaskWorkflow(driver: SqlDriver): TaskWorkflow {
  const rows = driver.all<{ marker: string; n: number }>(
    `SELECT marker, COUNT(*) AS n FROM block
     WHERE deleted_at IS NULL AND marker IN ('TODO','DOING','LATER','NOW')
     GROUP BY marker`,
  );
  let laterNow = 0;
  let todoDoing = 0;
  for (const r of rows) {
    if (r.marker === "LATER" || r.marker === "NOW") laterNow += r.n;
    else todoDoing += r.n;
  }
  return inferTaskWorkflow({ laterNow, todoDoing });
}

/** What a client should start from when its reader has not chosen: recorded, else inferred. */
export function suggestedTaskWorkflow(driver: SqlDriver): TaskWorkflow {
  return recordedTaskWorkflow(driver) ?? inferredTaskWorkflow(driver);
}
