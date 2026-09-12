/**
 * Where a page's reference filter and the panel's sort are remembered (research/13 §4.2 item 5).
 *
 * Per device, in `localStorage`, NOT as a page property — the choice ADR 021 records. Logseq
 * writes `filters:: {"aurora" true}` into the page file so the filter syncs; the cost is that
 * every click on the filter popover becomes a graph write — an op in the log, an entry in the
 * mirror, a `changes.since` event agents see, a batch someone can undo — and that a reading
 * preference shows up in the page's properties block. Filtering what you look at is a fact about
 * this screen, like the theme and the shelf (`../app/theme.ts`, `../app/shelf.ts`), and the
 * markdown mirror is supposed to stay a clean copy of the notes (ADR 003).
 *
 * One JSON object under one key, keyed by the page's normalized name, with empty filters removed
 * on save — so a graph with 900 pages does not leave 900 keys behind. The sort is a single
 * preference rather than per page: "recent" vs "by name" is a habit, not a fact about a page.
 */

import type { ReferenceFilter, ReferenceSort } from "./referenceGrouping.js";
import { EMPTY_FILTER, isFilterEmpty } from "./referenceGrouping.js";

const FILTERS_KEY = "nooklet.referenceFilters";
const SORT_KEY = "nooklet.referenceSort";

type Stored = Record<string, ReferenceFilter>;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Privacy modes throw on touching storage at all; the filter simply does not persist.
    return undefined;
  }
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function readAll(): Stored {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(FILTERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Stored = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const f = value as Partial<ReferenceFilter> | undefined;
      if (f && isStringList(f.include) && isStringList(f.exclude)) {
        out[key] = { include: f.include, exclude: f.exclude };
      }
    }
    return out;
  } catch {
    // A corrupt value must not take the references panel down; start clean.
    return {};
  }
}

function writeAll(all: Stored): void {
  const store = storage();
  if (!store) return;
  try {
    if (Object.keys(all).length === 0) store.removeItem(FILTERS_KEY);
    else store.setItem(FILTERS_KEY, JSON.stringify(all));
  } catch {
    // Quota or storage disabled: the in-memory filter still works for this visit.
  }
}

/** The remembered filter for `pageKey` (a `normalizePageName` result), or none. */
export function loadReferenceFilter(pageKey: string): ReferenceFilter {
  return readAll()[pageKey] ?? EMPTY_FILTER;
}

export function saveReferenceFilter(pageKey: string, filter: ReferenceFilter): void {
  const all = readAll();
  if (isFilterEmpty(filter)) delete all[pageKey];
  else all[pageKey] = filter;
  writeAll(all);
}

export function loadReferenceSort(): ReferenceSort {
  try {
    const v = storage()?.getItem(SORT_KEY);
    if (v === "recent" || v === "name") return v;
  } catch {
    // As above.
  }
  return "recent";
}

export function saveReferenceSort(sort: ReferenceSort): void {
  try {
    storage()?.setItem(SORT_KEY, sort);
  } catch {
    // As above.
  }
}
