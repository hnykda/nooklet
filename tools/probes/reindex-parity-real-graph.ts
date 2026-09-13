/**
 * Probe for the reindex-walk change (docs/review/2026-09-13-m7-rv-server-sync.md, F8 / B-85 note):
 * does rebuilding `ref` and `path_ref` through `childLookup` reproduce, row for row, the derived
 * tables the old full-scan walk built on a real graph? Rebuilds every block's `ref` rows and every
 * top-level block's subtree `path_ref`, then diffs against the tables as they were.
 *
 * Run against a COPY of a graph (it writes):
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/reindex-parity-real-graph.ts /tmp/x/graph.sqlite
 */

import { reindexBlockAndSubtree } from "../../packages/server/src/apply-ops.ts";
import { childLookup } from "../../packages/server/src/block-children.ts";
import { openDb } from "../../packages/server/src/db.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: reindex-parity-real-graph.ts <copy of graph.sqlite>");
const driver = openDb({ path });

const dump = (table: "ref" | "path_ref"): string[] =>
  driver
    .all<Record<string, unknown>>(`SELECT * FROM ${table}`)
    // `ref.id` is an autoincrement surrogate: a rebuild renumbers it, the reference is the rest.
    .map(({ id: _id, ...r }) => JSON.stringify(r))
    .sort();

const before = { ref: dump("ref"), path_ref: dump("path_ref") };
const t0 = performance.now();
driver.transaction(() => {
  const children = childLookup(driver);
  const all = driver.all<{ id: string; parent_id: string | null }>(
    "SELECT id, parent_id FROM block",
  );
  // Leaves first would be cheapest; order does not matter for the result, only `ref` before paths.
  for (const b of all) if (b.parent_id !== null) reindexBlockAndSubtree(driver, b.id, children);
  for (const b of all) if (b.parent_id === null) reindexBlockAndSubtree(driver, b.id, children);
});
const ms = Math.round(performance.now() - t0);
const after = { ref: dump("ref"), path_ref: dump("path_ref") };

for (const table of ["ref", "path_ref"] as const) {
  const a = new Set(before[table]);
  const b = new Set(after[table]);
  const lost = [...a].filter((x) => !b.has(x));
  const gained = [...b].filter((x) => !a.has(x));
  console.log(
    `${table}: ${a.size} rows before, ${b.size} after; ${lost.length} missing, ${gained.length} new`,
  );
  for (const x of lost.slice(0, 5)) console.log(`  - ${x}`);
  for (const x of gained.slice(0, 5)) console.log(`  + ${x}`);
}
console.log(`rebuilt in ${ms} ms`);
