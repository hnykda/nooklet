/**
 * How a page's name is *shown*, as opposed to how it is stored.
 *
 * For almost every page these are the same string. For a journal they are not: since ADR 018 a
 * journal page is stored as `2026-09-07` and rendered in whatever format the reader prefers —
 * `Sep 7th, 2026`, `Monday, 07.09.2026`, or the ISO date itself. The storage form is fixed so that
 * references, search, the API and the mirror all agree on one name; the display form is a
 * preference because "what a date looks like" is a matter of where you live, not of what the data
 * is.
 *
 * Every place that puts a page name in front of a person goes through `displayPageName`. The
 * exceptions are deliberate and few: anything that writes a name back into the graph (the title
 * editor, wikilink insertion) uses the stored name, because a display format must never become
 * data again — that round trip is exactly what ADR 018 exists to stop.
 */

import { DEFAULT_JOURNAL_TITLE_FORMAT, formatJournalTitle, parseJournalTitle } from "@nooklet/core";
import { createSignal } from "solid-js";

const STORAGE_KEY = "nooklet.journalTitleFormat";

/**
 * The formats offered in settings. date-fns patterns, with a rendered sample instead of the raw
 * pattern as the label, because `EEEE, dd.MM.yyyy` means nothing to anyone and `Monday,
 * 07.09.2026` means everything.
 */
export const JOURNAL_TITLE_PRESETS: ReadonlyArray<{ pattern: string; label: string }> = [
  { pattern: "MMM do, yyyy", label: "Sep 7th, 2026" },
  { pattern: "MMMM do, yyyy", label: "September 7th, 2026" },
  { pattern: "yyyy-MM-dd", label: "2026-09-07" },
  { pattern: "E, dd.MM.yyyy", label: "Mon, 07.09.2026" },
  { pattern: "EEEE, dd.MM.yyyy", label: "Monday, 07.09.2026" },
  { pattern: "EEEE, MMM do, yyyy", label: "Monday, Sep 7th, 2026" },
  { pattern: "dd.MM.yyyy", label: "07.09.2026" },
];

function load(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Only patterns we offer: a hand-edited localStorage value reaches `date-fns#format`, which
    // throws on an unknown token and would take the whole page down with it.
    if (stored && JOURNAL_TITLE_PRESETS.some((p) => p.pattern === stored)) return stored;
  } catch {
    // Private browsing, or storage disabled. The default is fine.
  }
  return DEFAULT_JOURNAL_TITLE_FORMAT;
}

const [format, setFormat] = createSignal(load());

/** The reader's chosen journal title format, as a date-fns pattern. Reactive. */
export const journalTitleFormat = format;

export function setJournalTitleFormat(pattern: string): void {
  if (!JOURNAL_TITLE_PRESETS.some((p) => p.pattern === pattern)) return;
  setFormat(pattern);
  try {
    localStorage.setItem(STORAGE_KEY, pattern);
  } catch {
    // Preference lost on reload; not worth surfacing.
  }
}

/**
 * What to show for a page. Journals render their day in the chosen format; everything else is its
 * own name.
 *
 * Reads `journalTitleFormat()`, so a component calling this re-renders when the setting changes —
 * which is why the whole app picks up a new format without a reload.
 */
export function displayPageName(page: { name: string; journalDay: number | null }): string {
  if (page.journalDay === null) return page.name;
  return formatJournalTitle(page.journalDay, format());
}

/**
 * Display form for a name we have not resolved to a page — a `[[…]]` target, a search hit, a
 * backlink header. If it parses as a journal day in any format, it shows in the chosen one;
 * otherwise it is passed through.
 *
 * Distinct from `displayPageName` because here the journal day is a guess from the string rather
 * than a fact from the row — see `canonicalRefName`'s note on why that guess is fine for a
 * reference and wrong for a page name.
 */
export function displayRefName(name: string): string {
  const day = parseJournalTitle(name);
  return day === null ? name : formatJournalTitle(day, format());
}
