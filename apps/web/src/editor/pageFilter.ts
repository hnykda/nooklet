/**
 * Find in page (audit §2 #16): which rows to show for a query, and where in a string it matches.
 *
 * Pure, like `tree.ts`: no DOM, no Solid. `BlockTree.tsx` swaps `flattenVisible` for
 * `filterVisible` while a query is active; `views/PageFindBar.tsx` uses `findRanges` to highlight
 * the rendered text.
 *
 * Matching is a substring test on the block's STORED text, folded for case and diacritics — so
 * "reka" finds "Řeka", which matters in a Czech+English graph where half the typing happens on a
 * keyboard layout without háčky. Stored text, not rendered text, because rendered rows are not all
 * in the DOM (children of a collapsed block are not rendered at all) and because what a person
 * remembers typing is the markdown. The cost: a query that only matches markup (`[[`, a URL
 * hidden behind a label) shows the row with nothing highlighted in it.
 *
 * The filter is purely visual. Matches under a collapsed block are shown along with every
 * ancestor, but no `block.collapsed` op is written — closing the find bar puts the outline back
 * exactly as it was.
 */
import { childrenIds, getBlock } from "./tree.js";
import type { BlockId, EditorTree, Row } from "./types.js";

const COMBINING_MARKS = /\p{M}/gu;

/** Lower-case and strip diacritics. `toLowerCase` first: "İ" lower-cases to "i" plus a combining
 * dot, which the mark strip then removes. */
export function foldForFind(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "");
}

export interface FilterOptions {
  /** Search only this block's subtree (the zoom root), root included. */
  rootBlockId?: BlockId;
  /** A block to show even though it does not match — the one being edited. Typing a block out of
   * matching must not unmount the row the editor lives in; it drops out once editing moves on. */
  keep?: BlockId | null;
}

export interface FilterResult {
  /** Matches and their ancestors, in reading order, at their real depth. */
  rows: Row[];
  /** Matching block ids in reading order. `keep` is not listed unless it matches. */
  matches: BlockId[];
}

/** `null` when the query folds to nothing — the caller shows the unfiltered outline. */
export function filterVisible(
  tree: EditorTree,
  query: string,
  opts: FilterOptions = {},
): FilterResult | null {
  const q = foldForFind(query.trim());
  if (q === "") return null;
  const matches: BlockId[] = [];

  const visit = (id: BlockId, depth: number): Row[] | null => {
    const b = getBlock(tree, id);
    const kids = childrenIds(tree, id);
    const isMatch = foldForFind(b.content).includes(q);
    // Pushed before the children are visited, so `matches` is in reading (pre-)order.
    if (isMatch) matches.push(id);
    const below: Row[] = [];
    // Collapsed or not: a match hidden under a collapsed parent is exactly what find is for.
    for (const c of kids) {
      const sub = visit(c, depth + 1);
      if (sub) below.push(...sub);
    }
    if (!isMatch && id !== opts.keep && below.length === 0) return null;
    return [{ id, depth, hasChildren: kids.length > 0, collapsed: b.collapsed }, ...below];
  };

  const rows: Row[] = [];
  if (opts.rootBlockId !== undefined) {
    if (!tree.byId.has(opts.rootBlockId)) return { rows, matches };
    rows.push(...(visit(opts.rootBlockId, 0) ?? []));
  } else {
    for (const id of childrenIds(tree, null)) rows.push(...(visit(id, 0) ?? []));
  }
  return { rows, matches };
}

/**
 * `[start, end)` offsets into `text` of every non-overlapping occurrence of `query`, compared
 * folded. The offsets are in the ORIGINAL string even where folding changed its length ("é"
 * written as "e" + U+0301 folds to one unit and maps back to two), so they can build DOM ranges.
 */
export function findRanges(text: string, query: string): Array<[number, number]> {
  const q = foldForFind(query.trim());
  if (q === "") return [];
  // For every folded code unit, the original [start, end) it came from.
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldForFind(ch);
    if (f === "" && ends.length > 0) {
      // A lone combining mark folds to nothing; it belongs to the unit before it, so a highlight
      // ending there does not split the grapheme.
      ends[ends.length - 1] = i + ch.length;
    }
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(q, from);
    if (at === -1) break;
    out.push([starts[at] as number, ends[at + q.length - 1] as number]);
    from = at + q.length;
  }
  return out;
}
