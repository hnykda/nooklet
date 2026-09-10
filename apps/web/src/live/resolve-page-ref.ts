/**
 * Resolves a `PageRef`-shaped string (page id, name, `YYYY-MM-DD`, or `today`/`yesterday`/
 * `tomorrow` — `docs/spec/mcp-tools.md`'s `PageRef` schema) against the LOCAL replica, for
 * `nav.openPage` (ADR 015 §2.4) — the one thing no existing `nav.*` command does (every other one
 * opens a picker or a fixed destination). Pure apart from the injected `PageRefQuery`, so this is
 * testable without a real SQLite worker; `../app/hosts.ts` supplies the real queries.
 */

import { dateToJournalDay, isId } from "@nooklet/core";

export interface ResolvedPageRef {
  id: string;
  name: string;
  journalDay: number | null;
}

export interface PageRefQuery {
  byId(id: string): Promise<ResolvedPageRef | null>;
  byName(name: string): Promise<ResolvedPageRef | null>;
  byJournalDay(day: number): Promise<ResolvedPageRef | null>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `"today"`/`"yesterday"`/`"tomorrow"`, or a literal `YYYY-MM-DD`, to a `journal_day` int
 * (`YYYYMMDD`, `@nooklet/core`'s `JournalDay`). `null` for anything else. */
export function journalDayForRef(ref: string, now: () => Date = () => new Date()): number | null {
  const lower = ref.trim().toLowerCase();
  if (lower === "today") return dateToJournalDay(now());
  if (lower === "yesterday") {
    const d = now();
    d.setDate(d.getDate() - 1);
    return dateToJournalDay(d);
  }
  if (lower === "tomorrow") {
    const d = now();
    d.setDate(d.getDate() + 1);
    return dateToJournalDay(d);
  }
  if (ISO_DATE_RE.test(ref.trim())) {
    const [y, m, d] = ref.trim().split("-").map(Number);
    return dateToJournalDay(new Date(y as number, (m as number) - 1, d as number));
  }
  return null;
}

/**
 * Resolution order: an id (`isId`) first; then a journal-date/keyword by `journal_day`; finally an
 * exact page name. Returns `null` when nothing matches — `nav.openPage`'s `run()` then does
 * nothing rather than navigating somewhere wrong, the same "quietly no-op on the unexpected" stance
 * `../commands/hosts/nav-host.ts#followLink`'s block case already takes.
 */
export async function resolvePageRef(
  ref: string,
  query: PageRefQuery,
  now?: () => Date,
): Promise<ResolvedPageRef | null> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  if (isId(trimmed)) {
    const byId = await query.byId(trimmed);
    if (byId) return byId;
  }

  const day = journalDayForRef(trimmed, now);
  if (day !== null) {
    const byDay = await query.byJournalDay(day);
    if (byDay) return byDay;
  }

  return query.byName(trimmed);
}
