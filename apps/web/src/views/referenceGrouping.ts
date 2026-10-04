/**
 * Pure grouping, sorting and filtering for the page view's linked/unlinked references panels
 * (BUILD item 2; docs/spec/sql-schema.md rule 13/14, docs/spec/mcp-tools.md §4.3.6). The server's
 * `page.backlinks` op already returns `linked` sorted `ORDER BY src_page.updated_at DESC` — a
 * single, page-major sort across *all* rows, not pre-grouped — so "grouped by source page, most
 * recently updated page first" still needs one pass here: compute each page's most-recent
 * timestamp among its own refs, order pages by that, and keep the refs within a page ordered too.
 * Split out from `views/PageView.tsx` so it is testable with no DOM/component at all (see
 * `referenceGrouping.test.ts`).
 *
 * M7 (research/13 §4.2 item 5) adds Logseq's reference filter and a sort on top, both pure:
 *
 * - **Filter candidates** are "the other pages each referencing block mentions" — its source page
 *   plus every `[[page]]`/`#tag` in its text — keyed by `normalizePageName` (ADR 004) so
 *   `[[Aurora]]` and `#aurora` are one candidate. The text the server returns is the block's
 *   first line only, so refs on continuation lines are not candidates; a limitation worth knowing
 *   rather than a bug worth a server round-trip per block.
 * - **Include is AND, exclude is OR**, which is what Logseq's `filters::` does and what reads
 *   naturally: "only blocks that also mention Aurora *and* Q3", "but none that mention Done".
 * - **Counts come from the filtered list**, never the raw one, so the number on the heading always
 *   matches what is under it.
 */
import { extractRefs, normalizePageName } from "@nooklet/core";
import type { BacklinkRef } from "../data/api-client.js";

export interface ReferenceGroup {
  page: string;
  refs: BacklinkRef[];
}

export type ReferenceSort = "recent" | "name";

/** Normalized page keys to require (all) and to reject (any). */
export interface ReferenceFilter {
  include: string[];
  exclude: string[];
}

export const EMPTY_FILTER: ReferenceFilter = { include: [], exclude: [] };

export interface FilterCandidate {
  /** `normalizePageName` of the page — the identity the filter stores. */
  key: string;
  /** The first spelling seen, for display. */
  name: string;
  /** How many of the (unfiltered) refs mention it. */
  count: number;
}

/** The pages one referencing block "also mentions": its own page and every page ref/tag in its
 * text, as normalized keys. The page the panel belongs to is deliberately in here too when the
 * text names it — filtering on it is a no-op, and the popover hides it, but keeping the function
 * honest about what the text says costs nothing. */
export function referencedKeys(ref: BacklinkRef): string[] {
  const keys = new Set<string>([normalizePageName(ref.page)]);
  const refs = extractRefs(ref.text);
  for (const name of [...refs.pageRefs, ...refs.tags]) keys.add(normalizePageName(name));
  return [...keys];
}

/**
 * Every page mentioned across `linked`, with counts, most-mentioned first (ties by name). `omit`
 * is the panel's own page key: it is mentioned by every linked ref by definition, so offering it
 * as a filter would be a button that does nothing.
 */
export function filterCandidates(linked: readonly BacklinkRef[], omit?: string): FilterCandidate[] {
  const byKey = new Map<string, FilterCandidate>();
  for (const ref of linked) {
    const seen = new Set<string>();
    const names = new Map<string, string>([[normalizePageName(ref.page), ref.page]]);
    const refs = extractRefs(ref.text);
    for (const name of [...refs.pageRefs, ...refs.tags]) {
      const key = normalizePageName(name);
      if (!names.has(key)) names.set(key, name);
    }
    for (const [key, name] of names) {
      if (key === omit || seen.has(key)) continue;
      seen.add(key);
      const c = byKey.get(key);
      if (c) c.count++;
      else byKey.set(key, { key, name, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Keep the refs that mention every `include` key and none of the `exclude` keys. */
export function applyReferenceFilter(
  linked: readonly BacklinkRef[],
  filter: ReferenceFilter,
): BacklinkRef[] {
  if (filter.include.length === 0 && filter.exclude.length === 0) return [...linked];
  return linked.filter((ref) => {
    const keys = new Set(referencedKeys(ref));
    if (filter.exclude.some((k) => keys.has(k))) return false;
    return filter.include.every((k) => keys.has(k));
  });
}

/** Cycle one key through the three filter states: off → included → excluded → off. Returns a
 * new filter; never mutates. */
export function cycleFilterKey(filter: ReferenceFilter, key: string): ReferenceFilter {
  if (filter.include.includes(key)) {
    return { include: filter.include.filter((k) => k !== key), exclude: [...filter.exclude, key] };
  }
  if (filter.exclude.includes(key)) {
    return { include: filter.include, exclude: filter.exclude.filter((k) => k !== key) };
  }
  return { include: [...filter.include, key], exclude: filter.exclude };
}

export function isFilterEmpty(filter: ReferenceFilter): boolean {
  return filter.include.length === 0 && filter.exclude.length === 0;
}

/** Group `linked` by `page`. `"recent"` (the default) orders pages by their most-recently-updated
 * ref first (ties broken by page name for determinism) and refs within a page the same way;
 * `"name"` orders pages alphabetically and keeps refs most-recent first within each. */
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * When a group happened, for "Recent" (B-766). A journal day (its wire name is the ISO date) is
 * dated by the DAY, not by its blocks' edit times: an imported graph stamps every block with the
 * import time, so by edit time every day tied and the name tie-break listed them oldest first
 * (Oct 4th, Sept 5th, Sept 14th). The end of the day, so a page edited that day sorts with it
 * rather than ahead of it. Any other page has no date of its own and keeps its latest edit.
 */
function groupTime(page: string, latestEdit: number): number {
  const m = ISO_DAY_RE.exec(page);
  if (!m) return latestEdit;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) - 1;
}

export function groupLinkedReferences(
  linked: readonly BacklinkRef[],
  sort: ReferenceSort = "recent",
): ReferenceGroup[] {
  const byPage = new Map<string, { refs: BacklinkRef[]; mostRecent: number }>();
  for (const r of linked) {
    const t = r.updatedAt ? Date.parse(r.updatedAt) : Number.NEGATIVE_INFINITY;
    let g = byPage.get(r.page);
    if (!g) {
      g = { refs: [], mostRecent: Number.NEGATIVE_INFINITY };
      byPage.set(r.page, g);
    }
    g.refs.push(r);
    if (t > g.mostRecent) g.mostRecent = t;
  }
  for (const [page, g] of byPage) g.mostRecent = groupTime(page, g.mostRecent);
  const entries = [...byPage.entries()];
  entries.sort(
    sort === "name"
      ? ([pageA], [pageB]) => pageA.localeCompare(pageB)
      : ([pageA, a], [pageB, b]) => b.mostRecent - a.mostRecent || pageA.localeCompare(pageB),
  );
  return entries.map(([page, g]) => ({
    page,
    refs: [...g.refs].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "")),
  }));
}

/** Group `unlinked` mentions by page, alphabetically (there is no `updated_at` on an unlinked hit
 * — it is a plain-text FTS match, docs/spec/sql-schema.md rule 14 — so recency has no meaning
 * here). */
export function groupUnlinkedReferences(unlinked: readonly BacklinkRef[]): ReferenceGroup[] {
  const byPage = new Map<string, BacklinkRef[]>();
  for (const r of unlinked) {
    const arr = byPage.get(r.page);
    if (arr) arr.push(r);
    else byPage.set(r.page, [r]);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([page, refs]) => ({ page, refs }));
}
