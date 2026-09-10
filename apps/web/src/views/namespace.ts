/**
 * Pure namespace display helpers (BUILD item 2; PLAN.md §8: "the page shows its children as a
 * tree... lists display the short form with the namespace dimmed"). The child-listing *query*
 * itself lives in `../data/store.ts#useNamespaceChildren` (docs/spec/sql-schema.md rule 3's GLOB
 * query, verbatim); this module is the display-shaping half plus a predicate the query's SQL
 * mirrors exactly, kept here so it's testable with no DB/component at all
 * (`namespace.test.ts`).
 */
import { namespaceParent, namespaceParts } from "@nooklet/core";

export interface NamespaceLabel {
  /** "A/B/C" -> "A/B"; "A" -> null. */
  parent: string | null;
  /** The last path segment, for the dimmed-namespace/short-form display. */
  short: string;
}

export function namespaceLabel(name: string): NamespaceLabel {
  const parts = namespaceParts(name);
  return { parent: namespaceParent(name), short: parts.at(-1) ?? name };
}

/** True iff `pageKey` is a direct or indirect child of namespace `namespaceKey` (both already
 * `normalizePageName`d). Mirrors the SQL `key GLOB :ns || '/*'` predicate exactly — a page is
 * never its own child, and "ab" is not a child of "a" (the "/" boundary matters). */
export function isNamespaceChild(pageKey: string, namespaceKey: string): boolean {
  return pageKey.startsWith(`${namespaceKey}/`);
}
