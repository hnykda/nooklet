/**
 * The `page_alias` derived index (sql-schema.md rule 6): which other names a page answers to,
 * from its `alias::` property. Like `ref`, `path_ref` and `page_tag` it is rebuilt from the page's
 * current state on every write and never written by hand — the one raw INSERT that used to exist
 * (`page.update keep_alias`) put a row in this table that no other device and no `rebuild()` would
 * ever reproduce, and nothing at all populated it from an imported `alias::`, so the owner's graph
 * had three aliased pages and an empty table.
 *
 * Aliases resolve in two places, both here so they cannot drift:
 *  - a page LOOKUP by name falls back to an alias (`data-api.ts`'s `pages.get({name})`);
 *  - a REFERENCE to an alias (`[[Nick]]` where `Nick` is an alias of `Real`) is indexed with
 *    `ref.dst_page_id` / `path_ref.page_id` pointing at the real page (`resolvePageIdForKey`,
 *    `reresolveIndexTargets`), and backlinks are computed over the page's own key plus its alias
 *    keys (`pageLookupKeys`, rule 13).
 */

import { aliasKeysOf } from "../page-alias.js";
import type { SqlDriver } from "./driver.js";

/** Current alias keys of a page, from the index. */
export function pageAliasKeys(driver: SqlDriver, pageId: string): string[] {
  return driver
    .all<{ alias_key: string }>("SELECT alias_key FROM page_alias WHERE page_id = ?", [pageId])
    .map((r) => r.alias_key);
}

/** The page's own key plus every alias key: the set a backlinks query matches `path_ref.page_key`
 * against (sql-schema.md rule 13). */
export function pageLookupKeys(driver: SqlDriver, page: { id: string; key: string }): string[] {
  return [page.key, ...pageAliasKeys(driver, page.id)];
}

/**
 * The page a reference key means: the page whose own key it is, else the live page that lists it
 * as an alias, else nothing. Own key wins so that an alias can never shadow a real page.
 */
export function resolvePageIdForKey(driver: SqlDriver, key: string): string | null {
  const own = driver.get<{ id: string }>(
    "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL",
    [key],
  );
  if (own) return own.id;
  const viaAlias = driver.get<{ page_id: string }>(
    `SELECT pa.page_id FROM page_alias pa JOIN page p ON p.id = pa.page_id
     WHERE pa.alias_key = ? AND p.deleted_at IS NULL LIMIT 1`,
    [key],
  );
  return viaAlias?.page_id ?? null;
}

/**
 * Recompute one page's aliases from its `alias::` property. Returns the alias keys it had before
 * plus the ones it has now — every key whose resolution this change may have altered. Does not
 * re-resolve anything itself; `reindexPageIdentity` does, with the page's own key folded in.
 */
export function rebuildPageAliases(driver: SqlDriver, pageId: string): string[] {
  const before = pageAliasKeys(driver, pageId);
  driver.run("DELETE FROM page_alias WHERE page_id = ?", [pageId]);

  const page = driver.get<{ key: string; deleted_at: number | null }>(
    "SELECT key, deleted_at FROM page WHERE id = ?",
    [pageId],
  );
  let after: string[] = [];
  // A deleted page answers to no aliases; a page that never existed has none to answer to.
  if (page && page.deleted_at === null) {
    const prop = driver.get<{ value: string | null }>(
      "SELECT value FROM page_prop WHERE page_id = ? AND key = 'alias'",
      [pageId],
    );
    after = aliasKeysOf(prop?.value, page.key);
    for (const key of after) {
      driver.run("INSERT OR IGNORE INTO page_alias(page_id, alias_key) VALUES (?, ?)", [
        pageId,
        key,
      ]);
    }
  }
  return [...new Set([...before, ...after])];
}

/**
 * After any write to a page: rebuild its aliases, then re-resolve every reference key whose
 * answer this page could have changed — its alias keys old and new, its own key, and any key
 * that currently resolves to it (a rename leaves those pointing at a page that no longer has that
 * name; a delete leaves them pointing at a tombstone). This is also what makes a `[[Page]]`
 * written before `Page` existed resolve the moment the page is created, rather than the next time
 * that block happens to be edited. The page-write equivalent of `rebuildRefRows`.
 */
export function reindexPageIdentity(driver: SqlDriver, pageId: string): void {
  const keys = new Set(rebuildPageAliases(driver, pageId));
  const page = driver.get<{ key: string }>("SELECT key FROM page WHERE id = ?", [pageId]);
  if (page) keys.add(page.key);
  for (const row of driver.all<{ k: string }>(
    `SELECT dst_page_key AS k FROM ref WHERE dst_page_id = ? AND dst_page_key IS NOT NULL
     UNION SELECT page_key FROM path_ref WHERE page_id = ?
     UNION SELECT tag_key FROM page_tag WHERE tag_page_id = ?`,
    [pageId, pageId, pageId],
  )) {
    keys.add(row.k);
  }
  reresolveIndexTargets(driver, [...keys]);
}

/**
 * Re-point `ref.dst_page_id`, `path_ref.page_id` and `page_tag.tag_page_id` for the given keys
 * (or for every key, when `keys` is omitted) through `resolvePageIdForKey`'s own-key-then-alias
 * rule. The keys themselves never change here — only what they resolve to.
 */
export function reresolveIndexTargets(driver: SqlDriver, keys?: readonly string[]): void {
  const distinct =
    keys ??
    [
      ...driver.all<{ k: string }>(
        `SELECT dst_page_key AS k FROM ref WHERE dst_page_key IS NOT NULL
         UNION SELECT page_key FROM path_ref
         UNION SELECT tag_key FROM page_tag`,
      ),
    ].map((r) => r.k);
  for (const key of distinct) {
    const target = resolvePageIdForKey(driver, key);
    driver.run("UPDATE ref SET dst_page_id = ? WHERE dst_page_key = ?", [target, key]);
    driver.run("UPDATE path_ref SET page_id = ? WHERE page_key = ?", [target, key]);
    driver.run("UPDATE page_tag SET tag_page_id = ? WHERE tag_key = ?", [target, key]);
  }
}
