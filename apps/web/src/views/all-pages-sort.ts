/** The All pages view's column sort (B-645), apart from the view so it tests without a DOM. */

export type SortKey = "name" | "blocks" | "words" | "created" | "updated";

export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** What a first click on a header means: names A→Z, everything else biggest/newest first. */
const FIRST_DESC: Record<SortKey, boolean> = {
  name: false,
  blocks: true,
  words: true,
  created: true,
  updated: true,
};

/** Clicking the active header flips it; any other header starts at its natural direction. */
export function nextSort(current: Sort, key: SortKey): Sort {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: FIRST_DESC[key] };
}
