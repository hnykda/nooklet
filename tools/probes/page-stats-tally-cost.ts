/**
 * Probe (B-645): what the All pages counts cost by themselves — `PAGE_STATS_SQL` + `tallyPageStats`
 * over a real graph's SQLite, in Node (node:sqlite; the browser's sqlite-wasm in a worker is
 * slower per row, which `all-pages-columns-real-graph.mjs` measures end to end).
 *
 * Usage: pnpm --filter @nooklet/server exec tsx ../../tools/probes/page-stats-tally-cost.ts <graph.sqlite>
 */

import { DatabaseSync } from "node:sqlite";
import { PAGE_STATS_SQL, tallyPageStats } from "../../apps/web/src/data/page-stats.js";

const file = process.argv[2];
if (!file) throw new Error("usage: page-stats-tally-cost.ts <graph.sqlite>");
const db = new DatabaseSync(file, { readOnly: true });
const times: { query: number; tally: number }[] = [];
let pages = 0;
let rows = 0;
for (let i = 0; i < 7; i++) {
  const t0 = performance.now();
  const r = db.prepare(PAGE_STATS_SQL).all() as unknown as { page_id: string; content: string }[];
  const t1 = performance.now();
  const stats = tallyPageStats(r);
  const t2 = performance.now();
  times.push({ query: t1 - t0, tally: t2 - t1 });
  pages = stats.size;
  rows = r.length;
}
const med = (k: "query" | "tally") =>
  times
    .map((t) => t[k])
    .sort((a, b) => a - b)
    [Math.floor(times.length / 2)]?.toFixed(1);
console.log(
  `${rows} blocks on ${pages} pages: query ${med("query")} ms, tally ${med("tally")} ms (median of 7)`,
);
