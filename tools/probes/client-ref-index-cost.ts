/**
 * B-641: can a client replica keep the reference index (`ref`/`path_ref`/`page_tag`/`page_alias`)
 * itself, what does building it cost on a real graph, and does it come out the same as the
 * server's?
 *
 * Loads `@sqlite.org/sqlite-wasm` in Node (the engine the browser, desktop app and phone run;
 * in-memory VFS, so read the times as a lower bound — OPFS adds I/O, a phone's CPU is slower),
 * copies `page`/`block`/`block_prop`/`page_prop` out of a server graph file, then:
 *
 *  1. "existing replica" — rows first, then `ensureClientRefIndex` (queues a full rebuild), then
 *     the first `drainRefIndex`: the one-time migration cost an installed app pays.
 *  2. parity — the four tables, row for row, against the server's own.
 *  3. "bootstrap" — index first, then every row inserted (the triggers mark them all), then drain.
 *  4. incremental — one `block.text` edit through core's `applyOps` on a leaf and on the block with
 *     the biggest subtree, then drain.
 *  5. reads — `backlinkRows` for the most-referenced pages.
 *
 * Usage (from apps/web, so its deps resolve):
 *   pnpm exec tsx ../../tools/probes/client-ref-index-cost.ts <graph.sqlite>
 */

import { DatabaseSync } from "node:sqlite";
import sqlite3InitModule from "../../apps/web/node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs";
import { drainRefIndex, ensureClientRefIndex } from "../../apps/web/src/db/ref-index-client.js";
import { ensureClientSearchIndex } from "../../apps/web/src/db/schema-client.js";
import { createSqliteWasmDriver } from "../../apps/web/src/db/sqlite-wasm-driver.js";
import {
  applyOps,
  backlinkRows,
  formatHlc,
  initSchema,
  makeOp,
  resolveBacklinksTarget,
  type SqlDriver,
} from "../../packages/core/src/index.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: client-ref-index-cost.ts <graph.sqlite>");
  process.exit(2);
}
const src = new DatabaseSync(file, { readOnly: true });
const sqlite3 = await sqlite3InitModule();
console.log(`sqlite-wasm ${sqlite3.version.libVersion}`);

const TABLES = ["page", "block", "block_prop", "page_prop"] as const;
const rowsOf = Object.fromEntries(
  TABLES.map((t) => [t, src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]]),
) as Record<(typeof TABLES)[number], Record<string, unknown>[]>;
console.log(
  `${rowsOf.page.length} pages, ${rowsOf.block.length} blocks, ${rowsOf.block_prop.length} block props, ${rowsOf.page_prop.length} page props`,
);

function fresh(): SqlDriver {
  const db = new sqlite3.oo1.DB(":memory:");
  const driver = createSqliteWasmDriver(db as never);
  initSchema(driver);
  return driver;
}

function copyRows(driver: SqlDriver): void {
  driver.transaction(() => {
    for (const t of TABLES) {
      for (const r of rowsOf[t]) {
        // `due_day` is generated; everything else goes across as is.
        const cols = Object.keys(r).filter((c) => !(t === "block" && c === "due_day"));
        driver.run(
          `INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          cols.map((c) => r[c]),
        );
      }
    }
  });
}

function time<T>(label: string, fn: () => T): T {
  const t = performance.now();
  const out = fn();
  console.log(`${label}: ${(performance.now() - t).toFixed(0)} ms`);
  return out;
}

// 1. An installed replica that predates the index.
const existing = fresh();
time("copy rows (not part of the cost)", () => copyRows(existing));
ensureClientSearchIndex(existing);
time("ensureClientRefIndex (tables + triggers)", () => ensureClientRefIndex(existing));
const first = time("first drain = one-time migration (full rebuild)", () =>
  drainRefIndex(existing),
);
console.log("  ", first);

// 2. Parity with the server's own tables.
const PARITY: Record<string, string> = {
  ref: "SELECT src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id FROM ref",
  path_ref: "SELECT block_id, page_key, page_id FROM path_ref",
  page_tag: "SELECT page_id, tag_key, tag_page_id, source FROM page_tag",
  page_alias: "SELECT page_id, alias_key FROM page_alias",
};
for (const [table, sql] of Object.entries(PARITY)) {
  const key = (r: Record<string, unknown>) => JSON.stringify(Object.values(r));
  const server = (src.prepare(sql).all() as Record<string, unknown>[]).map(key).sort();
  const client = existing.all<Record<string, unknown>>(sql).map(key).sort();
  const s = new Set(server);
  const c = new Set(client);
  const onlyServer = server.filter((x) => !c.has(x));
  const onlyClient = client.filter((x) => !s.has(x));
  console.log(
    `parity ${table}: server ${server.length}, client ${client.length}, only-server ${onlyServer.length}, only-client ${onlyClient.length}`,
  );
  for (const x of onlyServer.slice(0, 3)) console.log("   only server:", x);
  for (const x of onlyClient.slice(0, 3)) console.log("   only client:", x);
}

// 3. A fresh bootstrap: index first, then the snapshot's rows. Baseline: the FTS triggers alone,
// which every bootstrap already paid before B-641.
const ftsOnly = fresh();
ensureClientSearchIndex(ftsOnly);
time("bootstrap insert, FTS triggers only (before B-641)", () => copyRows(ftsOnly));
const boot = fresh();
ensureClientSearchIndex(boot);
ensureClientRefIndex(boot);
time("bootstrap insert with triggers marking", () => copyRows(boot));
console.log("   dirty rows:", boot.get<{ n: number }>("SELECT count(*) AS n FROM ref_dirty")?.n);
console.log(
  "  ",
  time("bootstrap drain", () => drainRefIndex(boot)),
);

// 4. Incremental: one edit, then drain.
const biggest = existing.get<{ id: string; n: number }>(
  `WITH RECURSIVE sub(root, id) AS (
     SELECT id, id FROM block WHERE parent_id IS NULL AND deleted_at IS NULL
     UNION ALL SELECT s.root, b.id FROM block b JOIN sub s ON b.parent_id = s.id
   ) SELECT root AS id, count(*) AS n FROM sub GROUP BY root ORDER BY n DESC LIMIT 1`,
);
const leaf = existing.get<{ id: string }>(
  `SELECT b.id FROM block b WHERE b.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM block c WHERE c.parent_id = b.id) LIMIT 1`,
);
let counter = 0;
function edit(blockId: string, suffix = " [[probe page]]"): void {
  const content = existing.get<{ content: string }>("SELECT content FROM block WHERE id = ?", [
    blockId,
  ])?.content;
  const hlc = formatHlc({ wall: Date.now() + 10_000_000, counter: counter++, device: "probe001" });
  applyOps(existing, [
    makeOp(hlc, "probe001", blockId, { kind: "block.text", content: `${content}${suffix}` }),
  ]);
}
if (leaf) {
  edit(leaf.id);
  console.log(
    "  ",
    time("edit a leaf, then drain", () => drainRefIndex(existing)),
  );
}
if (biggest) {
  edit(biggest.id);
  console.log(
    "  ",
    time(`edit the root of the biggest subtree (${biggest.n} blocks), then drain`, () =>
      drainRefIndex(existing),
    ),
  );
}
if (biggest) {
  edit(biggest.id, " more words, no new link");
  console.log(
    "  ",
    time("edit the same root again without touching a link, then drain", () =>
      drainRefIndex(existing),
    ),
  );
}
time("drain with nothing dirty", () => drainRefIndex(existing));

// 5. Reads.
const busiest = existing.all<{ page_key: string; n: number }>(
  "SELECT page_key, count(*) AS n FROM path_ref GROUP BY page_key ORDER BY n DESC LIMIT 3",
);
for (const b of busiest) {
  const name =
    existing.get<{ name: string }>("SELECT name FROM page WHERE key = ?", [b.page_key])?.name ??
    b.page_key;
  const out = time(`backlinkRows("${name}") with unlinked`, () =>
    backlinkRows(existing, resolveBacklinksTarget(existing, name), {
      includeUnlinked: true,
      unlinkedLimit: 500,
    }),
  );
  console.log(
    `   linked ${out.linked.length} (direct ${out.linked.filter((r) => r.direct === 1).length}), unlinked ${out.unlinked.length}, tagged ${out.tagged.length}`,
  );
}
