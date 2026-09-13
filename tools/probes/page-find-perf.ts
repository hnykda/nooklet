/**
 * How long does find in page (`apps/web/src/editor/pageFilter.ts#filterVisible`) take per
 * keystroke on the biggest real page? It folds every block's text on every call, uncached.
 *
 * Run (from the repo root, with a JSON dump of one page's blocks):
 *   sqlite3 -json <graph-copy>/graph.sqlite "select b.id, b.parent_id as parentId,
 *     b.order_key as \"order\", b.content, b.collapsed from block b join page p
 *     on p.id = b.page_id where b.deleted_at is null and p.name = 'OmnivoreSync';" > page.json
 *   pnpm --filter @nooklet/web exec tsx ../../tools/probes/page-find-perf.ts <abs path>/page.json
 *
 * Result 2026-09-13 (owner's graph copy, page "OmnivoreSync": 961 blocks, 1.69 MB of text, a Mac
 * under a dozen agents' load). Per-character folding, as first written: filterVisible 21-51 ms per
 * call, findRanges over every block 670-890 ms. With folded text cached per block object and only
 * non-ASCII runs folded per character: 0.2-1.5 ms and 12-17 ms. Also in docs/bugs-inbox B-232.
 */
import { readFileSync } from "node:fs";
import { filterVisible, findRanges } from "../../apps/web/src/editor/pageFilter.js";
import { buildEditorTree } from "../../apps/web/src/editor/tree.js";
import type { EditableBlock } from "../../apps/web/src/editor/types.js";

const path = process.argv[2];
if (!path) throw new Error("usage: page-find-perf.ts <page.json>");
const rows = JSON.parse(readFileSync(path, "utf8")) as Array<{
  id: string;
  parentId: string | null;
  order: string;
  content: string;
  collapsed: number;
}>;
const blocks: EditableBlock[] = rows.map((r) => ({
  id: r.id,
  parentId: r.parentId,
  order: r.order,
  content: r.content,
  marker: null,
  priority: null,
  collapsed: r.collapsed !== 0,
  scheduled: null,
  deadline: null,
  repeat: null,
  doneAt: null,
  listNumber: false,
}));
const tree = buildEditorTree("probe", blocks);
const chars = blocks.reduce((n, b) => n + b.content.length, 0);
console.log(`${blocks.length} blocks, ${chars} chars`);

// Each prefix of a typed query is one keystroke's work.
for (const query of ["r", "re", "rek", "reka", "zzzz-no-match", "the"]) {
  const runs = 20;
  const t0 = performance.now();
  let matches = 0;
  for (let i = 0; i < runs; i++) matches = filterVisible(tree, query)?.matches.length ?? 0;
  const ms = (performance.now() - t0) / runs;
  console.log(`${JSON.stringify(query).padEnd(16)} ${ms.toFixed(2)} ms/call, ${matches} matches`);
}

// The bar's highlight pass runs `findRanges` over the rendered text of every matching row. Stored
// text stands in for rendered text here (same order of size).
for (const query of ["r", "reka", "the"]) {
  const t0 = performance.now();
  let ranges = 0;
  for (const b of blocks) ranges += findRanges(b.content, query).length;
  console.log(
    `findRanges ${JSON.stringify(query).padEnd(8)} over all blocks: ${(performance.now() - t0).toFixed(1)} ms, ${ranges} ranges`,
  );
}
