/**
 * The `page_tag` derived index (ADR 017): which pages carry which tags.
 *
 * Blocks get their tags through `ref`, whose `src_block_id` is `NOT NULL` — so a fact about a
 * *page* has nowhere to live there. This is the page-level equivalent, and like `ref` it is
 * derived: rebuilt from the page's current state on every write, never written by hand.
 *
 * Two sources, and the distinction is what makes the UI honest:
 *
 * - `property` — the page's `tags` property (`tags:: person, czech`), which is what Logseq graphs
 *   carry and what the importer already brings across. Set and removed by the user.
 * - `intrinsic` — a fact the page already has. Exactly one rule today: a page with a journal day
 *   is a `Journal`. Not removable, because there is nothing sensible for removing it to mean —
 *   the page either has a journal day or it does not.
 *
 * Deriving rather than storing `tags:: Journal` on each daily page is deliberate: writing it would
 * put one fact in two places that can disagree, and a graph imported without that property would
 * have journals that were not Journals. See ADR 017 for the alternatives and why they lost.
 */

import { canonicalRefName } from "../journal.js";
import { normalizePageName } from "../page-name.js";
import { splitList } from "../refs.js";
import type { SqlDriver } from "./driver.js";

/** The tag every journal day carries. Capitalised because people see and link to it by hand;
 * lookups normalise case anyway. */
export const JOURNAL_TAG = "Journal";

/** Strips the `[[…]]` or `#` a tag may be written with, so `[[Person]]`, `#Person` and `Person`
 * are one tag. */
function bareTagName(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("[[") && trimmed.endsWith("]]")
      ? trimmed.slice(2, -2)
      : trimmed.startsWith("#")
        ? trimmed.slice(1)
        : trimmed;
  return unwrapped.trim();
}

/**
 * Recompute one page's tags. Call after anything that changes its `tags` property, its journal
 * day, or its existence — the page-write equivalent of `rebuildRefRows`.
 */
export function rebuildPageTags(driver: SqlDriver, pageId: string): void {
  driver.run("DELETE FROM page_tag WHERE page_id = ?", [pageId]);

  const page = driver.get<{ journal_day: number | null; deleted_at: number | null }>(
    "SELECT journal_day, deleted_at FROM page WHERE id = ?",
    [pageId],
  );
  // A deleted page carries no tags; a page that never existed has none to carry.
  if (!page || page.deleted_at !== null) return;

  const tags = new Map<string, { name: string; source: "property" | "intrinsic" }>();

  if (page.journal_day !== null) {
    tags.set(normalizePageName(JOURNAL_TAG), { name: JOURNAL_TAG, source: "intrinsic" });
  }

  const tagsProp = driver.get<{ value: string | null }>(
    "SELECT value FROM page_prop WHERE page_id = ? AND key = 'tags'",
    [pageId],
  );
  if (tagsProp?.value) {
    for (const item of splitList(tagsProp.value)) {
      const name = bareTagName(item);
      if (name === "") continue;
      // Same canonicalisation `ref` uses (ADR 018), so `tags:: Sep 7th, 2026` and a `[[2026-09-07]]`
      // in a block agree about which page they mean.
      const key = normalizePageName(canonicalRefName(name));
      // An intrinsic tag wins: `tags:: Journal` on a journal day is the same tag, and calling it
      // user-removable would be a lie.
      if (!tags.has(key)) tags.set(key, { name, source: "property" });
    }
  }

  for (const [key, { source }] of tags) {
    const target = driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL",
      [key],
    );
    driver.run("INSERT INTO page_tag(page_id, tag_key, tag_page_id, source) VALUES (?, ?, ?, ?)", [
      pageId,
      key,
      target?.id ?? null,
      source,
    ]);
  }
}

export interface TaggedPageRow {
  page_id: string;
  source: "property" | "intrinsic";
}

/**
 * The live pages carrying any of `tagKeys` (a tag page's own key plus its alias keys — the same set
 * backlinks match references against), excluding `excludePageId`: a page tagged with itself is not
 * news on its own tag page. A page tagged twice over (by its name and by an alias) is listed once,
 * as `intrinsic` if either row is. Ordinary pages come first by name, then journal days newest
 * first — under `Journal` that is the order a reader scans, and under a tag mixing both the named
 * pages are worth seeing before a run of dates. ADR 017's `tagged_pages` (B-111).
 */
export function pagesTaggedWith(
  driver: SqlDriver,
  tagKeys: readonly string[],
  excludePageId: string | null,
): TaggedPageRow[] {
  if (tagKeys.length === 0) return [];
  const placeholders = tagKeys.map(() => "?").join(",");
  return driver.all<TaggedPageRow>(
    `SELECT pt.page_id AS page_id,
            CASE WHEN MAX(pt.source = 'intrinsic') THEN 'intrinsic' ELSE 'property' END AS source
     FROM page_tag pt JOIN page p ON p.id = pt.page_id AND p.deleted_at IS NULL
     WHERE pt.tag_key IN (${placeholders}) AND p.id IS NOT ?
     GROUP BY pt.page_id
     ORDER BY p.journal_day IS NOT NULL, p.journal_day DESC, p.key`,
    [...tagKeys, excludePageId],
  );
}
