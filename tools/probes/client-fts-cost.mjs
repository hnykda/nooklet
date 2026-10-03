/**
 * Can the client replica afford its own FTS5 index, and how fast is a local keyword search?
 * (server-search, 2026-10-03.) The owner wants search to fall back to "local search" when the
 * server is not reachable; the replica had no full-text index at all (only the server did), so
 * the question is whether sqlite-wasm — the engine the browser, the desktop app and the phone all
 * run — has FTS5 compiled in, and what building and querying the index costs on a real graph.
 *
 * Loads `@sqlite.org/sqlite-wasm` in Node (same wasm build as the client, in-memory VFS, so read
 * the numbers as a lower bound: OPFS adds I/O, a phone's CPU is slower), copies `page` and `block`
 * out of a graph file with node:sqlite, creates the same FTS DDL the client uses
 * (`apps/web/src/db/schema-client.ts`), rebuilds it, and times a few queries of the shape
 * `apps/web/src/data/local-search.ts` runs.
 *
 * Usage: node tools/probes/client-fts-cost.mjs <copy-of-graph.sqlite> [query ...]
 */

import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { default: sqlite3InitModule } = await import(require.resolve("@sqlite.org/sqlite-wasm"));

const [file, ...queriesArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: client-fts-cost.mjs <copy-of-graph.sqlite> [query ...]");
  process.exit(2);
}
const queries = queriesArg.length > 0 ? queriesArg : ['"todo"', '"cesky"*', '"meeting" "notes"'];

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(":memory:");
console.log(`sqlite-wasm ${sqlite3.version.libVersion}`);
console.log(
  "fts5 compiled in:",
  db.selectValue("SELECT sqlite_compileoption_used('ENABLE_FTS5')") === 1,
);

db.exec(`CREATE TABLE page (id TEXT PRIMARY KEY, name TEXT, journal_day INTEGER, deleted_at INTEGER, updated_at INTEGER);
CREATE TABLE block (id TEXT PRIMARY KEY, page_id TEXT, content TEXT, deleted_at INTEGER, updated_at INTEGER);`);
const src = new DatabaseSync(file, { readOnly: true });
const pages = src.prepare("SELECT id, name, journal_day, deleted_at, updated_at FROM page").all();
const blocks = src.prepare("SELECT id, page_id, content, deleted_at, updated_at FROM block").all();
db.transaction(() => {
  for (const p of pages)
    db.exec({
      sql: "INSERT INTO page VALUES (?,?,?,?,?)",
      bind: [p.id, p.name, p.journal_day, p.deleted_at, p.updated_at],
    });
  for (const b of blocks)
    db.exec({
      sql: "INSERT INTO block VALUES (?,?,?,?,?)",
      bind: [b.id, b.page_id, b.content, b.deleted_at, b.updated_at],
    });
});
console.log(`${pages.length} pages, ${blocks.length} blocks`);

const tokenize = `tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"`;
let t = performance.now();
db.exec(`CREATE VIRTUAL TABLE block_fts USING fts5(content, content='block', content_rowid='rowid', ${tokenize});
CREATE VIRTUAL TABLE page_fts USING fts5(name, content='page', content_rowid='rowid', ${tokenize});
INSERT INTO block_fts(block_fts) VALUES('rebuild');
INSERT INTO page_fts(page_fts) VALUES('rebuild');`);
console.log(`rebuild: ${(performance.now() - t).toFixed(0)} ms`);

for (const q of queries) {
  const runs = 20;
  let rows = 0;
  t = performance.now();
  for (let i = 0; i < runs; i++) {
    rows = db.selectArrays(
      `SELECT b.id, snippet(block_fts, 0, '**', '**', '...', 25)
       FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
       JOIN page p ON p.id = b.page_id
       WHERE block_fts MATCH ? AND b.deleted_at IS NULL AND p.deleted_at IS NULL
       ORDER BY bm25(block_fts) LIMIT 50`,
      [q],
    ).length;
  }
  console.log(`${q}: ${rows} rows, ${((performance.now() - t) / runs).toFixed(2)} ms/query`);
}
