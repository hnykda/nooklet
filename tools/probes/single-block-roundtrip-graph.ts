/**
 * Probe (2026-09-13, server-ops, B-172/B-151): on a REAL graph, does every live block survive
 * `block.update`'s own round trip — `renderSingleBlockText` (the `before` text an `old_str` edit
 * is matched against) → `parseSingleBlockGrammar(text, "flush")` — with content, marker, priority,
 * properties and collapsed unchanged? Also counts how many blocks the pre-fix parser (bullet on
 * line 1 only) refused outright, i.e. how many blocks an agent could not edit by `old_str` at all.
 *
 * Read-only: opens the database with `node:sqlite` directly and never writes. Point it at a COPY
 * (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`), never at
 * the owner's live graph. Run from packages/server:
 *   pnpm exec tsx ../../tools/probes/single-block-roundtrip-graph.ts <path-to-graph.sqlite>
 *
 * Result on the owner's graph copy (2026-09-13, 18.6k blocks): see
 * docs/progress/server-ops.md ("Real-graph checks").
 */
import { DatabaseSync } from "node:sqlite";
import { parseOutline } from "../../packages/core/src/outline.js";
import { createNodeSqliteDriver } from "../../packages/core/src/sync/node-sqlite-driver.js";
import {
  parseSingleBlockGrammar,
  renderSingleBlockText,
} from "../../packages/server/src/ops/outline-bridge.js";
import { BLOCK_COLUMNS, type BlockRow, rowToBlock } from "../../packages/server/src/rows.js";

const path = process.argv[2];
if (!path || path.includes("/.nooklet/default")) {
  console.error("usage: single-block-roundtrip-graph.ts <COPY of graph.sqlite>");
  process.exit(2);
}
const driver = createNodeSqliteDriver(new DatabaseSync(path, { readOnly: true }));
const rows = driver.all<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM block WHERE deleted_at IS NULL`);

let multiLine = 0;
let oldRefused = 0;
let newRefused = 0;
const mismatches = new Map<string, { count: number; example: string }>();
const note = (kind: string, example: string) => {
  const m = mismatches.get(kind) ?? { count: 0, example };
  m.count++;
  mismatches.set(kind, m);
};

for (const row of rows) {
  const block = rowToBlock(driver, row);
  const text = renderSingleBlockText(block);
  if (text.includes("\n")) multiLine++;
  // The pre-fix parser, verbatim in effect: a bullet before line 1 only.
  if (parseOutline(`- ${text}`).blocks.length !== 1) oldRefused++;
  let node: ReturnType<typeof parseSingleBlockGrammar>;
  try {
    node = parseSingleBlockGrammar(text, "flush");
  } catch (e) {
    newRefused++;
    note(`refused: ${(e as Error).message}`, `${row.id} ${JSON.stringify(text.slice(0, 120))}`);
    continue;
  }
  const ex = `${row.id} ${JSON.stringify(text.slice(0, 160))}`;
  if (node.content !== block.content) note("content differs", ex);
  if (node.marker !== block.marker) note("marker differs", ex);
  if (node.priority !== block.priority) note("priority differs", ex);
  if (node.collapsed !== block.collapsed) note("collapsed differs", ex);
  if (JSON.stringify(sorted(node.properties)) !== JSON.stringify(sorted(block.properties)))
    note("properties differ", ex);
}

function sorted(p: Record<string, string>): Array<[string, string]> {
  return Object.entries(p).sort(([a], [b]) => a.localeCompare(b));
}

console.log(`live blocks: ${rows.length}; before-text with 2+ lines: ${multiLine}`);
console.log(`refused by the pre-fix parser: ${oldRefused}; refused now: ${newRefused}`);
for (const [kind, { count, example }] of mismatches)
  console.log(`  ${kind}: ${count}  e.g. ${example}`);
