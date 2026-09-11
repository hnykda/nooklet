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

import type { SqlDriver } from "@nooklet/core";
import { canonicalRefName, normalizePageName, splitList } from "@nooklet/core";

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
