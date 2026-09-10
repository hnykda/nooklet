/**
 * R72-R73: the palette/slash-menu ranking algorithm, shared by every fuzzy-matched surface
 * (command palette, page switcher, slash menu, `[[`/`#` autocomplete — R69).
 */
import fuzzysort from "fuzzysort";
import type { RankedResult } from "../types.js";
import type { MruStore } from "./mru.js";
import { normalizeForMatch } from "./normalize.js";

export interface RankableItem {
  id: string;
  title: string;
  /** Extra searchable names (page aliases). Matched the same way as `title`; the better of the
   * two scores wins per candidate (R73: "also against each page's aliases, keeping the best of
   * the title/alias scores per page"). */
  aliases?: string[];
}

export interface RankOptions<T extends RankableItem> {
  query: string;
  /**
   * Candidates in the caller's chosen "empty query" fallback order (R72): for commands,
   * registration order grouped by category; for pages, most-recently-edited first. This function
   * never re-derives that order itself — it only interleaves the MRU list on top of whatever
   * order it's given, and (for a non-empty query) re-sorts entirely by match quality.
   */
  items: readonly T[];
  mru: MruStore;
  kind: "command" | "page";
}

function compareTuple<T extends RankableItem>(a: RankedResult<T>, b: RankedResult<T>): number {
  if (a.score !== b.score) {
    // R73 (1): fuzzy score descending. `score` is `number | null` here only for items with no
    // match, which are filtered out before sorting, so both sides are numbers at this point.
    return (b.score as number) - (a.score as number);
  }
  if (a.mruIndex !== b.mruIndex) {
    return a.mruIndex - b.mruIndex; // R73 (2): MRU position ascending (Infinity sorts last).
  }
  if (a.item.title !== b.item.title) {
    return a.item.title < b.item.title ? -1 : 1; // R73 (3): title, alphabetical.
  }
  if (a.item.id !== b.item.id) {
    return a.item.id < b.item.id ? -1 : 1; // R73 (4): id, alphabetical (final tiebreak).
  }
  return 0;
}

/** Best fuzzysort score across `title` and every alias, or `null` if none matched at all. */
function bestScore(query: string, item: RankableItem): number | null {
  let best: number | null = null;
  const titleResult = fuzzysort.single(query, normalizeForMatch(item.title));
  if (titleResult) best = titleResult.score;
  for (const alias of item.aliases ?? []) {
    const aliasResult = fuzzysort.single(query, normalizeForMatch(alias));
    if (aliasResult && (best === null || aliasResult.score > best)) best = aliasResult.score;
  }
  return best;
}

export function rankItems<T extends RankableItem>(opts: RankOptions<T>): RankedResult<T>[] {
  const { query, items, mru, kind } = opts;

  if (query.trim() === "") {
    // R72: MRU first (most-recent-first), then everything else in the caller's fallback order.
    return [...items]
      .map((item): RankedResult<T> => ({ item, score: null, mruIndex: mru.indexOf(kind, item.id) }))
      .sort((a, b) => a.mruIndex - b.mruIndex); // stable: ties (both Infinity) keep input order.
  }

  const normalizedQuery = normalizeForMatch(query);
  const results: RankedResult<T>[] = [];
  for (const item of items) {
    const score = bestScore(normalizedQuery, item);
    if (score === null) continue; // R73: discard candidates with no match.
    results.push({ item, score, mruIndex: mru.indexOf(kind, item.id) });
  }

  return results.sort(compareTuple);
}
