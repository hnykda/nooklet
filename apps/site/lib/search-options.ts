/**
 * MiniSearch configuration shared by the build (which creates the index) and the browser (which
 * loads it). `MiniSearch.loadJSON` needs the same fields and tokenizer the index was built with,
 * so both sides import this one object.
 */

import type { Options } from "minisearch";

export interface SearchDoc {
  id: string;
  /** Site URL with anchor, e.g. `/docs/sync#what-travels`. */
  url: string;
  page: string;
  heading: string;
  text: string;
  collection: "docs" | "decisions";
}

/** Folds diacritics so "zapis" finds "zápis"; nooklet's own users write in Czech and English. */
function fold(term: string): string {
  return term
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export const SEARCH_OPTIONS: Options<SearchDoc> = {
  fields: ["page", "heading", "text"],
  storeFields: ["url", "page", "heading", "text", "collection"],
  processTerm: (term) => fold(term) || null,
  searchOptions: {
    boost: { page: 3, heading: 2 },
    prefix: true,
    fuzzy: 0.15,
    combineWith: "AND",
  },
};

export const SEARCH_INDEX_URL = "/search-index.json";
