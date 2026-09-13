/**
 * Probe (2026-09-13, core-ops, B-310/B-390): on a REAL graph, does every page's mirror file read
 * back as the tree it was written from? Renders each live page exactly as `mirror/export.ts` does
 * (`serializeOutline(pageMirrorOutline(readPageOutline(…)))`), parses the text with `parseOutline`,
 * and compares block by block: id, content, marker, priority, collapsed, properties, child count,
 * plus the page properties. "The mirror is lossless" is the claim under test.
 *
 * Read-only: opens the database with `node:sqlite` directly and never writes. Point it at a COPY
 * (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`), never at
 * the owner's live graph. Run from packages/server:
 *   pnpm exec tsx ../../tools/probes/mirror-roundtrip-graph.ts <path-to-graph.sqlite>
 *
 * Result on the owner's graph copy (2026-09-13 13:08, 952 pages, 18,628 live blocks): the old
 * parser read 441 pages back differently, the fixed one 2 (the 20 pre-B-266 `SCHEDULED:` lines).
 * Details in docs/progress/core-ops.md ("Real-graph checks").
 */
import { DatabaseSync } from "node:sqlite";
import type { OutlineNode } from "../../packages/core/src/model.js";
import { parseOutline, serializeOutline } from "../../packages/core/src/outline.js";
import { createNodeSqliteDriver } from "../../packages/core/src/sync/node-sqlite-driver.js";
import { pageMirrorOutline, readPageOutline } from "../../packages/core/src/sync/page-outline.js";

const path = process.argv[2];
if (!path || path.includes("/.nooklet/default")) {
  console.error("usage: mirror-roundtrip-graph.ts <COPY of graph.sqlite>");
  process.exit(2);
}
const driver = createNodeSqliteDriver(new DatabaseSync(path, { readOnly: true }));
const pages = driver.all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL");

let blocks = 0;
let pagesDiffering = 0;
const mismatches = new Map<string, { count: number; example: string }>();
const note = (kind: string, example: string) => {
  const m = mismatches.get(kind) ?? { count: 0, example };
  m.count++;
  mismatches.set(kind, m);
};
const sorted = (p: Record<string, string>) =>
  JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));

for (const { id } of pages) {
  const rendered = readPageOutline(driver, id);
  if (!rendered) continue;
  const written = pageMirrorOutline(rendered);
  const text = serializeOutline(written);
  const back = parseOutline(text);
  let differs = false;
  const diff = (kind: string, ex: string) => {
    differs = true;
    note(kind, ex);
  };
  if (sorted(back.properties) !== sorted(written.properties)) {
    diff("page properties differ", `${rendered.name} ${sorted(back.properties).slice(0, 120)}`);
  }
  const walk = (a: readonly OutlineNode[], b: readonly OutlineNode[], where: string) => {
    if (a.length !== b.length) diff("sibling count differs", `${where} ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i] as OutlineNode;
      const y = b[i] as OutlineNode;
      blocks++;
      const ex = `${rendered.name} ${x.id} ${JSON.stringify(x.content.slice(0, 80))}`;
      if (x.id !== y.id) diff("id differs", ex);
      if (x.content !== y.content) diff("content differs", ex);
      if (x.marker !== y.marker) diff("marker differs", ex);
      if (x.priority !== y.priority) diff("priority differs", ex);
      if (x.collapsed !== y.collapsed) diff("collapsed differs", ex);
      if (sorted(x.properties) !== sorted(y.properties)) diff("properties differ", ex);
      walk(x.children, y.children, `${where}/${x.id}`);
    }
  };
  walk(written.blocks, back.blocks, rendered.name);
  if (differs) pagesDiffering++;
}

console.log(`live pages: ${pages.length}; blocks compared: ${blocks}`);
console.log(`pages whose mirror text reads back differently: ${pagesDiffering}`);
for (const [kind, { count, example }] of mismatches)
  console.log(`  ${kind}: ${count}  e.g. ${example}`);
