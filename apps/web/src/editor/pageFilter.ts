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

/**
 * Folded text per block object. Folding a 1.7 MB page (the owner's biggest, 961 blocks) took
 * 20-50 ms per call (`tools/probes/page-find-perf.ts`), and a call happens on every keystroke in
 * the find bar. Block objects are rebuilt when the page refetches but not between keystrokes in
 * the bar, so keying on the object makes typing a query cheap without ever serving stale text.
 */
const foldedContent = new WeakMap<object, string>();

function foldedOf(block: { content: string }): string {
  let f = foldedContent.get(block);
  if (f === undefined) {
    f = foldForFind(block.content);
    foldedContent.set(block, f);
  }
  return f;
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
    const isMatch = foldedOf(b).includes(q);
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

/** Runs of non-ASCII characters. Everything outside them folds by `toLowerCase` alone, one unit
 * for one unit, so only these runs need a per-character map. */
const NON_ASCII_RUN = /[\u0080-\u{10ffff}]+/gu;

interface Segment {
  /** Offset of the segment in the folded string. */
  folded: number;
  /** Offset of the segment in the original string. */
  original: number;
  /** Per folded unit, its original `[start, end)`; absent for an ASCII segment (identity map). */
  starts?: number[];
  ends?: number[];
}

/**
 * `[start, end)` offsets into `text` of every non-overlapping occurrence of `query`, compared
 * folded. The offsets are in the ORIGINAL string even where folding changed its length ("é"
 * written as "e" + U+0301 folds to one unit and maps back to two), so they can build DOM ranges.
 *
 * Folding character by character is what makes that mapping exact, and it is slow: done for every
 * character, the highlight pass over the owner's biggest page (1.7 MB) took 700-900 ms on every
 * keystroke in the find bar (`tools/probes/page-find-perf.ts`). So only non-ASCII runs are folded
 * per character; ASCII runs are lower-cased in one call and map by offset.
 */
export function findRanges(text: string, query: string): Array<[number, number]> {
  const q = foldForFind(query.trim());
  if (q === "") return [];
  let folded = "";
  const segments: Segment[] = [];
  // A combining mark that folds to nothing extends the end of the unit before it — which may sit
  // in the preceding ASCII segment — so a highlight ending there does not split the grapheme.
  const extendedEnd = new Map<number, number>();

  const ascii = (from: number, to: number): void => {
    if (to <= from) return;
    segments.push({ folded: folded.length, original: from });
    folded += text.slice(from, to).toLowerCase();
  };
  let last = 0;
  for (const run of text.matchAll(NON_ASCII_RUN)) {
    const at = run.index;
    ascii(last, at);
    const starts: number[] = [];
    const ends: number[] = [];
    const segmentStart = folded.length;
    let i = at;
    let part = "";
    for (const ch of run[0]) {
      const f = foldForFind(ch);
      if (f === "") {
        if (ends.length > 0) ends[ends.length - 1] = i + ch.length;
        else if (folded.length > 0) extendedEnd.set(folded.length - 1, i + ch.length);
      }
      for (let k = 0; k < f.length; k++) {
        starts.push(i);
        ends.push(i + ch.length);
      }
      part += f;
      i += ch.length;
    }
    if (part !== "") {
      segments.push({ folded: segmentStart, original: at, starts, ends });
      folded += part;
    }
    last = at + run[0].length;
  }
  ascii(last, text.length);

  // Occurrences are found left to right, so the segment lookup only ever moves forward.
  let cursor = 0;
  const segmentAt = (pos: number): Segment => {
    while (cursor + 1 < segments.length && (segments[cursor + 1] as Segment).folded <= pos) {
      cursor++;
    }
    return segments[cursor] as Segment;
  };
  const originalStart = (pos: number): number => {
    const seg = segmentAt(pos);
    return seg.starts ? (seg.starts[pos - seg.folded] as number) : seg.original + pos - seg.folded;
  };
  const originalEnd = (pos: number): number => {
    const extended = extendedEnd.get(pos);
    if (extended !== undefined) return extended;
    const seg = segmentAt(pos);
    return seg.ends ? (seg.ends[pos - seg.folded] as number) : seg.original + pos - seg.folded + 1;
  };

  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(q, from);
    if (at === -1) break;
    const start = originalStart(at);
    out.push([start, originalEnd(at + q.length - 1)]);
    from = at + q.length;
  }
  return out;
}
