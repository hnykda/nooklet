/**
 * The sentence the History view shows after an Undo or a Restore that left later edits alone
 * (B-251). The walk used to overwrite them with nothing on screen saying so; now `batch.undo`
 * keeps them and reports each one, and this turns that report into one line a person can act on:
 * how many, and on which pages — the pages matter most, because they are usually not this one.
 */

import type { KeptEdit } from "../data/refactor-api.js";

const MAX_PAGES_NAMED = 3;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `""` when nothing was kept; otherwise e.g. "1 block changed again later was left as it is, on
 * Megapage." A walk reports one entity at every step that skipped it, so entities are counted
 * once. */
export function keptEditsSentence(kept: readonly KeptEdit[]): string {
  const byId = new Map<string, KeptEdit>();
  for (const k of kept) if (!byId.has(k.id)) byId.set(k.id, k);
  if (byId.size === 0) return "";
  let blocks = 0;
  let pages = 0;
  const pageNames: string[] = [];
  for (const k of byId.values()) {
    if (k.entityType === "block") blocks++;
    else pages++;
    if (!pageNames.includes(k.page)) pageNames.push(k.page);
  }
  const what = [blocks > 0 ? plural(blocks, "block") : "", pages > 0 ? plural(pages, "page") : ""]
    .filter(Boolean)
    .join(" and ");
  const one = byId.size === 1;
  const named = pageNames.slice(0, MAX_PAGES_NAMED).join(", ");
  const more = pageNames.length - MAX_PAGES_NAMED;
  const where = more > 0 ? `${named} and ${plural(more, "more page")}` : named;
  return `${what} changed again later ${one ? "was" : "were"} left as ${one ? "it is" : "they are"}, on ${where}.`;
}
