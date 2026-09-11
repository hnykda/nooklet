/**
 * The graph's *suggested* journal title format (ADR 018).
 *
 * A journal page is stored by ISO date and displayed in whatever format the reader chose — but on
 * the day you import a Logseq graph you have not chosen anything yet, and the sensible default is
 * not nooklet's own but the one you have been reading for years. A graph whose `config.edn` said
 * `:journal/page-title-format "E, dd.MM.yyyy"` should keep looking like that.
 *
 * So the importer records the source format here, `/api/session` hands it to the client, and the
 * client uses it only as the initial value: the moment someone picks a format in settings, their
 * choice is a per-device preference and this is never consulted again. A suggestion, not a
 * setting — which is why it lives beside `graph-identity.ts` rather than in some general settings
 * API that does not exist yet (sql-schema.md rule 25).
 */

import type { SqlDriver } from "@nooklet/core";

const KEY = "journal.title_format";

/** The format this graph came with, or `null` when it did not come with one. */
export function suggestedJournalTitleFormat(driver: SqlDriver): string | null {
  const row = driver.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = ?", [
    KEY,
  ]);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === "string" && parsed !== "" ? parsed : null;
  } catch {
    return null;
  }
}

export function setSuggestedJournalTitleFormat(driver: SqlDriver, pattern: string): void {
  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc)
     VALUES (?, 'default', ?, ?, '')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(pattern), Date.now()],
  );
}
