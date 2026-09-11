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

/**
 * A pattern we are willing to hand to `date-fns#format`, which throws on an unknown token and
 * would take the page down with it. Guards stored values and anything the server suggests.
 *
 * Validated by *using* it rather than by membership of the preset list: a Logseq graph can be
 * configured with any date-fns pattern, and rejecting `do MMM yyyy` because it is not one of the
 * seven we happen to offer would throw away the very thing the suggestion exists to preserve.
 */
function known(pattern: string | null | undefined): pattern is string {
  if (!pattern) return false;
  try {
    return formatJournalTitle(20260907, pattern) !== "";
  } catch {
    return false;
  }
}

/**
 * What the settings picker offers: the presets, plus the graph's own format when it is something
 * else — otherwise an imported graph's format would be active and unselectable, and the picker
 * would look broken to the one person it matters most to.
 */
export function journalTitleOptions(): ReadonlyArray<{ pattern: string; label: string }> {
  const active = format();
  if (JOURNAL_TITLE_PRESETS.some((p) => p.pattern === active)) return JOURNAL_TITLE_PRESETS;
  return [
    { pattern: active, label: formatJournalTitle(20260907, active) },
    ...JOURNAL_TITLE_PRESETS,
  ];
}

function load(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (known(stored)) return stored;
  } catch {
    // Private browsing, or storage disabled. The default is fine.
  }
  return DEFAULT_JOURNAL_TITLE_FORMAT;
}

const [format, setFormat] = createSignal(load());

/** The reader's chosen journal title format, as a date-fns pattern. Reactive. */
export const journalTitleFormat = format;

export function setJournalTitleFormat(pattern: string): void {
  if (!known(pattern)) return;
  setFormat(pattern);
  try {
    localStorage.setItem(STORAGE_KEY, pattern);
  } catch {
    // Preference lost on reload; not worth surfacing.
  }
}

/**
 * Adopt the format an imported graph was written in, as the *initial* value only.
 *
 * The point is the morning after an import: 825 journal pages that have read `Mon, 07.09.2026`
 * for four years should not all become `Sep 7th, 2026` because the storage layer changed its
 * mind. The graph's own format is the better default — but only a default. Anyone who has picked
 * a format keeps it, which is why this checks for a stored choice rather than just calling
 * `setJournalTitleFormat`.
 *
 * Called once from `initBootstrap`'s caller, with `BootstrapConfig.journalTitleFormat`.
 */
export function suggestJournalTitleFormat(pattern: string | undefined): void {
  if (!known(pattern)) return;
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return;
  } catch {
    // No storage means no stored choice; adopting the suggestion is right.
  }
  setFormat(pattern);
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
