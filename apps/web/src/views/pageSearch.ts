/**
 * Pure fuzzy page-matching for the page switcher (BUILD item 6; PLAN.md §9: "fuzzy match over
 * names and aliases with diacritics folded (č matches c)"). Split out from `PageFinder.tsx` so the
 * folding + ranking behavior is directly testable (`pageSearch.test.ts`) without mounting a
 * component. Uses fuzzysort (docs/spec/commands-and-keymap.md R69 names it as the library of
 * choice for exactly this: the palette, the page switcher, the slash menu, `[[`/`#` autocomplete).
 *
 * Alias matching (PLAN.md §9's "and aliases") is not implemented: an alias lives in
 * `page_prop`/`page_alias` (docs/spec/sql-schema.md rule 6), and matching over every page's
 * aliases here would mean a join `../data/store.ts#useAllPages` does not currently do. Noted as a
 * simplification in the task summary.
 */
import { formatJournalTitle, type PageRow } from "@nooklet/core";
import fuzzysort from "fuzzysort";

/** NFD-decompose and drop combining marks, then lowercase — "č" and "c" fold to the same key. */
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS_RE, "").toLowerCase();
}

/** The name shown/matched for a page: its display name, or (for a journal page) the formatted
 * journal title — PLAN.md §8: "Journal titles are display-only; the day is the identity." */
export function pageDisplayTitle(page: PageRow): string {
  return page.journalDay !== null ? formatJournalTitle(page.journalDay) : page.name;
}

export interface PageMatch {
  page: PageRow;
  title: string;
}

/** Fuzzy-match `pages` against `query`, diacritic-folded on both sides. An empty query returns the
 * first `limit` pages as-is (sorted however the caller sorted them) rather than "no results" — the
 * page switcher should show *something* the moment it opens. */
export function fuzzyFindPages(pages: readonly PageRow[], query: string, limit = 50): PageMatch[] {
  if (query.trim() === "") {
    return pages.slice(0, limit).map((page) => ({ page, title: pageDisplayTitle(page) }));
  }
  const results = fuzzysort.go(foldDiacritics(query), pages, {
    key: (page) => foldDiacritics(pageDisplayTitle(page)),
    limit,
    threshold: 0,
  });
  return results.map((r) => ({ page: r.obj, title: pageDisplayTitle(r.obj) }));
}
