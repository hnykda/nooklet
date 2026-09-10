/**
 * Pure grouping logic for the page view's linked/unlinked references panels (BUILD item 2;
 * docs/spec/sql-schema.md rule 13/14, docs/spec/mcp-tools.md §4.3.6). The server's `page.backlinks`
 * op already returns `linked` sorted `ORDER BY src_page.updated_at DESC` — a single, page-major
 * sort across *all* rows, not pre-grouped — so "grouped by source page, most recently updated page
 * first" still needs one pass here: compute each page's most-recent timestamp among its own refs,
 * order pages by that, and keep the refs within a page ordered too. Split out from
 * `views/PageView.tsx` so it is testable with no DOM/component at all (see
 * `referenceGrouping.test.ts`).
 */
import type { BacklinkRef } from "../data/api-client.js";

export interface ReferenceGroup {
  page: string;
  refs: BacklinkRef[];
}

/** Group `linked` by `page`, pages ordered by their most-recently-updated ref first (ties broken
 * by page name for determinism); refs within a page ordered most-recently-updated first too. */
export function groupLinkedReferences(linked: readonly BacklinkRef[]): ReferenceGroup[] {
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
  return [...byPage.entries()]
    .sort(([pageA, a], [pageB, b]) => b.mostRecent - a.mostRecent || pageA.localeCompare(pageB))
    .map(([page, g]) => ({
      page,
      refs: [...g.refs].sort(
        (a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
      ),
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
