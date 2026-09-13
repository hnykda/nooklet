/**
 * Resolving a page name that is one of a page's aliases, in the local replica (B-104).
 *
 * The server answers `page.read "garden"` and indexes `[[garden]]` against `Zahrada` when
 * `Zahrada` lists `alias:: garden` (`packages/server/src/page-aliases.ts`); the client route only
 * looked at `page.key`, so following that link — or typing the URL — said "This page doesn't exist
 * yet" and offered to create a second, competing page. The replica has no `page_alias` index
 * (sql-schema.md rule 1: derived tables are server-only), so this reads the raw `alias` rows of
 * `page_prop` and parses them with the same core function the server's index is built from.
 *
 * Callers try the page's own key (and a journal day) first; this is the last resort, so an alias
 * can never shadow a page that really has the name — the server's own-key-then-alias rule.
 */

import { aliasKeysOf, refKeyOf } from "@nooklet/core";
import { queryAs } from "../db/client.js";

export interface AliasCandidate {
  /** The page's own key, which `aliasKeysOf` excludes from its aliases. */
  key: string;
  /** The raw `alias::` value. */
  alias_value: string;
}

/** The first candidate (in the order given) whose `alias::` names `name`, or `null`. Pure. */
export function pickAliasedPage<Row extends AliasCandidate>(
  rows: readonly Row[],
  name: string,
): Row | null {
  const wanted = refKeyOf(name);
  if (wanted === "") return null;
  return rows.find((r) => aliasKeysOf(r.alias_value, r.key).includes(wanted)) ?? null;
}

/**
 * The live page one of whose aliases is `name`, as a full `page` row plus `alias_value`. When two
 * pages claim the same alias the older page wins — an arbitrary but stable choice (the server's
 * `resolvePageIdForKey` takes whichever row SQLite returns first).
 */
export async function findPageByAlias<Row extends AliasCandidate>(
  name: string,
): Promise<Row | null> {
  const rows = await queryAs<Row>(
    `SELECT p.*, pp.value AS alias_value
     FROM page_prop pp JOIN page p ON p.id = pp.page_id
     WHERE pp.key = 'alias' AND pp.value IS NOT NULL AND pp.value != '' AND p.deleted_at IS NULL
     ORDER BY p.created_at, p.id`,
  );
  return pickAliasedPage(rows, name);
}
