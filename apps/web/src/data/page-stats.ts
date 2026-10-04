/**
 * Per-page block and word counts for the All pages view (B-645), from the local replica alone:
 * one query over live blocks, tallied here. No server round trip per row (or at all), so the
 * columns are there offline and on a device with no server.
 *
 * The word rule is the word-count plugin's own (`plugins/word-count/src/count.ts`), imported rather
 * than copied, so the column and that plugin's status-bar item agree about the same page.
 *
 * One pass over every block's text, not a SQL aggregate: SQLite has no `\s+` split, and an
 * approximation (counting spaces) would disagree with the plugin on every double space, tab and
 * newline. Measured on the owner's 952-page graph (18.6k blocks, 2.9 MB of text) — see
 * `docs/progress/all-pages.md`.
 */

import { countWords } from "../../../../plugins/word-count/src/count.js";

export interface PageStats {
  blocks: number;
  words: number;
}

export function tallyPageStats(
  rows: Iterable<{ page_id: string; content: string }>,
): Map<string, PageStats> {
  const out = new Map<string, PageStats>();
  for (const r of rows) {
    let s = out.get(r.page_id);
    if (!s) {
      s = { blocks: 0, words: 0 };
      out.set(r.page_id, s);
    }
    s.blocks++;
    s.words += countWords(r.content);
  }
  return out;
}

/** The query `tallyPageStats` expects: every live block, page and text only. */
export const PAGE_STATS_SQL = "SELECT page_id, content FROM block WHERE deleted_at IS NULL";
