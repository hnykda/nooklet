/**
 * How a page's `alias::` value turns into the keys it answers to (sql-schema.md rule 6).
 *
 * Lives in core because two sides must agree on it and neither owns the other: the server builds
 * its derived `page_alias` index from this (`packages/server/src/page-aliases.ts`), and the client
 * — whose replica has `page_prop` but, like every derived table, no `page_alias` (sql-schema.md
 * rule 1) — resolves `/page/<alias>` from the raw property with it (B-104). Two parsers would
 * drift on exactly the cases real graphs have: `[[wrapped]]` items (Logseq writes aliases that
 * way), `#tagged` ones, and a comma inside brackets.
 */

import { canonicalRefName } from "./journal.js";
import { normalizePageName } from "./page-name.js";
import { splitList } from "./refs.js";

/** Strips the `[[…]]` or `#` an alias may be written with, so `[[Nick]]`, `#Nick` and `Nick` are
 * one alias — the same tolerance `page-tags.ts` extends to `tags::`. */
function bareName(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("[[") && trimmed.endsWith("]]")
      ? trimmed.slice(2, -2)
      : trimmed.startsWith("#")
        ? trimmed.slice(1)
        : trimmed;
  return unwrapped.trim();
}

/** The key a name has when it is used as a reference or an alias: journal dates in any title
 * format collapse to their ISO name (ADR 018), then the usual case/space folding. */
export function refKeyOf(name: string): string {
  return normalizePageName(canonicalRefName(name));
}

/** The normalised keys a page's `alias::` value names, excluding the page's own key. */
export function aliasKeysOf(aliasValue: string | null | undefined, ownKey: string): string[] {
  if (!aliasValue) return [];
  const keys = new Set<string>();
  for (const item of splitList(aliasValue)) {
    const name = bareName(item);
    if (name === "") continue;
    const key = refKeyOf(name);
    if (key !== ownKey) keys.add(key);
  }
  return [...keys];
}
