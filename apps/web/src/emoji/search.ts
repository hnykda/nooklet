/**
 * The pure half of the page-icon picker (B-647): name/keyword search over the emoji list, the
 * "you typed or pasted an emoji yourself" check, and arrow-key movement across a sectioned grid.
 * No DOM here, so all of it is unit-tested (`search.test.ts`).
 */

import type { EmojiData, EmojiRow } from "./types.js";

/** The first grapheme of `s` (trimmed): a flag or a skin-toned emoji is one, and stays whole. */
export function firstGrapheme(s: string): string {
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = seg.segment(trimmed)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment;
}

/**
 * The emoji the person typed or pasted themselves, or null when the query is a search word. A
 * grapheme counts when it is pictographic, a flag, or any non-ASCII symbol (★, ♞, ✓), since an icon
 * has always been allowed to be any short glyph. Letters and digits never count, in any script —
 * "č" starts a Czech search word, not an icon — and neither does ASCII punctuation, so ":rocket"
 * is still a search.
 */
export function rawEmoji(query: string): string | null {
  const g = firstGrapheme(query);
  if (g === "") return null;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return g;
  if (/^[\p{L}\p{N}\p{P}\p{Z}\p{C}]/u.test(g)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the point.
  if (/^[\x00-\x7f]/.test(g)) return null;
  return g;
}

export interface EmojiIndex {
  readonly data: EmojiData;
  /** Per row: the lowercased name's words and the keywords, for prefix matching. */
  readonly labelWords: readonly string[][];
  readonly tagWords: readonly string[][];
  readonly labels: readonly string[];
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s:,.\-_()“”"']+/)
    .filter((w) => w !== "");
}

export function buildIndex(data: EmojiData): EmojiIndex {
  return {
    data,
    labels: data.emojis.map((e) => e[1].toLowerCase()),
    labelWords: data.emojis.map((e) => words(e[1])),
    tagWords: data.emojis.map((e) => words(e[2])),
  };
}

/** Normalise what was typed into search terms. Slack/GitHub habits are kept: ":rocket:" and
 * "thumbs_up" search for "rocket" and "thumbs up". */
export function queryTerms(query: string): string[] {
  return words(query.replace(/_/g, " "));
}

/**
 * Every row whose name or keywords contain a word starting with each term, best first: the exact
 * name, then a name starting with the query, then a name containing all terms, then keyword-only
 * matches. Ties keep Unicode's order, so "heart" lists ❤️ before 💔.
 */
export function searchEmoji(index: EmojiIndex, query: string, limit = 240): EmojiRow[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const phrase = terms.join(" ");
  const scored: { row: EmojiRow; score: number; order: number }[] = [];
  const hit = (ws: readonly string[], t: string) => ws.some((w) => w.startsWith(t));
  index.data.emojis.forEach((row, i) => {
    const lw = index.labelWords[i] ?? [];
    const tw = index.tagWords[i] ?? [];
    if (!terms.every((t) => hit(lw, t) || hit(tw, t))) return;
    const label = index.labels[i] ?? "";
    const score =
      label === phrase ? 0 : label.startsWith(phrase) ? 1 : terms.every((t) => hit(lw, t)) ? 2 : 3;
    scored.push({ row, score, order: i });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.row);
}

/** One heading and its emojis, as the grid shows them. */
export interface EmojiSection {
  readonly title: string;
  readonly rows: readonly EmojiRow[];
}

/** The browse view (nothing typed): recents first, then each group in Unicode's order. */
export function browseSections(data: EmojiData, recents: readonly string[]): EmojiSection[] {
  const byGroup = new Map<number, EmojiRow[]>();
  const byEmoji = new Map<string, EmojiRow>();
  for (const row of data.emojis) {
    byEmoji.set(row[0], row);
    const list = byGroup.get(row[3]);
    if (list) list.push(row);
    else byGroup.set(row[3], [row]);
  }
  const sections: EmojiSection[] = [];
  // A recent icon need not be in the list (it was pasted, or is newer than the list): it is still
  // offered, named by itself.
  const recentRows = recents.map((e) => byEmoji.get(e) ?? ([e, e, "", -1] as const));
  if (recentRows.length > 0) sections.push({ title: "Recently used", rows: recentRows });
  for (const [group, rows] of [...byGroup].sort((a, b) => a[0] - b[0])) {
    sections.push({ title: data.groups[group] ?? "other", rows });
  }
  return sections;
}

/**
 * Where an arrow key moves the highlight in a grid of `cols` columns split into sections (each
 * starting on a new row). `at` and the result are flat indices across all sections; -1 means "in
 * the search field". Up from the first row goes back to the field; Down from the field enters the
 * grid. Up/Down cross into the neighbouring section at the same column (or its last cell, when
 * that row is shorter), the way the eye expects in a grid with headings between the blocks.
 */
export function moveInGrid(
  lengths: readonly number[],
  at: number,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  cols: number,
): number {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total === 0) return -1;
  if (at < 0) return key === "ArrowDown" ? 0 : -1;
  if (key === "ArrowRight") return Math.min(at + 1, total - 1);
  if (key === "ArrowLeft") return Math.max(at - 1, 0);

  // Locate `at` within its section.
  const starts: number[] = [];
  let acc = 0;
  for (const len of lengths) {
    starts.push(acc);
    acc += len;
  }
  let s = 0;
  while (s < lengths.length - 1 && at >= (starts[s] ?? 0) + (lengths[s] ?? 0)) s++;
  const len = lengths[s] ?? 0;
  const i = at - (starts[s] ?? 0);
  const col = i % cols;

  if (key === "ArrowDown") {
    if (i + cols < len) return at + cols;
    // A shorter last row below: its last cell.
    if (Math.floor(i / cols) < Math.floor((len - 1) / cols)) return (starts[s] ?? 0) + len - 1;
    for (let n = s + 1; n < lengths.length; n++) {
      const nl = lengths[n] ?? 0;
      if (nl > 0) return (starts[n] ?? 0) + Math.min(col, nl - 1);
    }
    return at;
  }
  // ArrowUp
  if (i - cols >= 0) return at - cols;
  for (let p = s - 1; p >= 0; p--) {
    const pl = lengths[p] ?? 0;
    if (pl > 0) {
      const lastRowStart = Math.floor((pl - 1) / cols) * cols;
      return (starts[p] ?? 0) + Math.min(lastRowStart + col, pl - 1);
    }
  }
  return -1;
}
