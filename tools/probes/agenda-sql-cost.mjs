/**
 * What does the journal agenda's read cost once it also takes dated blocks that are not tasks?
 * (repair-agenda, 2026-09-13.) The section's one query refetches after every write to `block`, so
 * a full scan of the block table would be paid on every debounced keystroke.
 *
 * Runs each candidate query against a COPY of a graph (node:sqlite, native — the client's wasm
 * SQLite is slower, so read the numbers as relative), prints EXPLAIN QUERY PLAN and the median of
 * RUNS executions. The candidate index is created on an in-memory copy of the database, never on
 * the file itself.
 *
 * Usage: node tools/probes/agenda-sql-cost.mjs <copy-of-graph.sqlite> [runs]
 */

import { DatabaseSync } from "node:sqlite";

const [file, runsArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: agenda-sql-cost.mjs <copy-of-graph.sqlite> [runs]");
  process.exit(2);
}
const RUNS = Number(runsArg ?? 50);

// A full in-memory copy of `page` and `block` (tables and their indexes) to experiment on.
const disk = new DatabaseSync(file, { readOnly: true });
const db = new DatabaseSync(":memory:");
db.exec(`ATTACH DATABASE '${file.replaceAll("'", "''")}' AS src`);
for (const { sql } of db
  .prepare("SELECT sql FROM src.sqlite_master WHERE type = 'table' AND name IN ('page','block')")
  .all()) {
  db.exec(sql);
}
db.exec("INSERT INTO main.page SELECT * FROM src.page");
db.exec(
  "INSERT INTO main.block (id, graph_id, page_id, parent_id, order_key, content, marker, priority, collapsed, scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at, created_at, updated_at, deleted_at, place_hlc, content_hlc, marker_hlc, priority_hlc, collapsed_hlc, scheduled_hlc, deadline_hlc, repeat_hlc, done_hlc, deleted_hlc) SELECT id, graph_id, page_id, parent_id, order_key, content, marker, priority, collapsed, scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at, created_at, updated_at, deleted_at, place_hlc, content_hlc, marker_hlc, priority_hlc, collapsed_hlc, scheduled_hlc, deadline_hlc, repeat_hlc, done_hlc, deleted_hlc FROM src.block",
);
db.exec("DETACH DATABASE src");
for (const { sql } of disk
  .prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'block' AND sql IS NOT NULL",
  )
  .all()) {
  db.exec(sql);
}
disk.close();
// No ANALYZE: neither the server nor the client replica ever runs it, so their planner works
// without sqlite_stat1 — and with it, this probe picked different plans than the app would.

const COLS = `b.id, b.page_id, b.order_key, b.content, b.marker, b.priority,
    b.scheduled_day, b.scheduled_time, b.deadline_day, b.deadline_time,
    p.name AS page_name, p.journal_day AS page_journal_day
  FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL`;
const OPEN = "('TODO','DOING','LATER','NOW','WAITING')";

const candidates = {
  "base: open tasks only": `SELECT ${COLS}
  WHERE b.deleted_at IS NULL AND b.marker IN ${OPEN}
    AND (b.scheduled_day IS NOT NULL OR b.deadline_day IS NOT NULL)`,
  "no index: open tasks OR marker IS NULL": `SELECT ${COLS}
  WHERE b.deleted_at IS NULL AND (b.marker IN ${OPEN} OR b.marker IS NULL)
    AND (b.scheduled_day IS NOT NULL OR b.deadline_day IS NOT NULL)`,
  "block_dated index: due_day IS NOT NULL": `SELECT ${COLS}
  WHERE b.deleted_at IS NULL AND b.due_day IS NOT NULL
    AND (b.marker IS NULL OR b.marker IN ${OPEN})`,
};

function measure(label, sql) {
  const stmt = db.prepare(sql);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => r.detail);
  const times = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    rows = stmt.all().length;
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      label,
      rows,
      medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
      plan,
    }),
  );
}

const blocks = db.prepare("SELECT count(*) AS n FROM block").get().n;
console.log(JSON.stringify({ file, blocks, runs: RUNS }));
measure("base: open tasks only", candidates["base: open tasks only"]);
measure("no index", candidates["no index: open tasks OR marker IS NULL"]);
db.exec(
  "CREATE INDEX block_dated ON block(due_day) WHERE deleted_at IS NULL AND due_day IS NOT NULL",
);
measure("with block_dated", candidates["block_dated index: due_day IS NOT NULL"]);
measure("no index form, block_dated present", candidates["no index: open tasks OR marker IS NULL"]);
