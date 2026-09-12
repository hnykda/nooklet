/**
 * Wire formats for the typed task-scheduling values (ADR 011): `scheduled`/`deadline` and `done`.
 *
 * The reducer (`sync/apply-ops.ts`) parses these strings into dedicated columns on the way in
 * (`SCHEDULED_RE`/`DONE_RE`); everything that reads those columns back out — the server's row
 * mappers, the change-audit snapshots, the markdown mirror, the web editor's optimistic model —
 * must produce byte-identical strings, or a round trip changes the value. Three copies of these
 * two functions used to live in three server files "to avoid a circular import"; this is the one.
 */

import { isoJournalName } from "./journal.js";

/** `YYYYMMDD` + optional `HH:MM` → `YYYY-MM-DD` / `YYYY-MM-DD HH:MM`. */
export function formatDayTime(day: number, time: string | null): string {
  const iso = isoJournalName(day);
  return time ? `${iso} ${time}` : iso;
}

/** Epoch ms → `YYYY-MM-DDTHH:MM:SSZ` (ISO 8601 UTC, seconds precision — exactly what `DONE_RE`
 * accepts on the way back in; milliseconds would be rejected). */
export function formatDoneIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
