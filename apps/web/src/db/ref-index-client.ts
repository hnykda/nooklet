/**
 * The replica's own reference index (B-641): `ref`/`path_ref`/`page_tag`/`page_alias`, derived by
 * `@nooklet/core`'s `reindexRefs` — the code the server runs in `serverApplyOps` — so the
 * references panel, its filters and its count, and the graph view answer from the device, offline
 * and in local-only mode, and say what the server would say.
 *
 * How it stays current. The server re-derives inside every write, from the ops it applies. A
 * replica's state changes along more paths than `applyOps` — a snapshot bootstrap inserts raw rows,
 * a refused page is removed by hand (`../sync/refused-page.ts`) — so instead of hooking each one,
 * SQL triggers note every block and page whose row, properties or existence changed in
 * `ref_dirty`, whatever wrote it, and `drainRefIndex` re-derives exactly those before a read. Typing
 * pays one `INSERT OR IGNORE` per write; the derivation runs when something reads references (the
 * panel under every page, so in practice right after the write, off the typing path).
 *
 * A replica that predates the index (or a fresh bootstrap, whose every row is dirty) is rebuilt
 * whole on its first drain instead: one pass over the graph is cheaper than per-block subtree
 * walks. Measured: `tools/probes/client-ref-index-cost.ts`.
 */

import { REF_INDEX_STATEMENTS, rebuildRefIndex, reindexRefs, type SqlDriver } from "@nooklet/core";

/** Above this many dirty blocks a drain rebuilds the whole index rather than walking subtrees:
 * a bootstrap or a long pull marks thousands, and the incremental path walks each one's subtree. */
export const FULL_REBUILD_THRESHOLD = 2000;

// Each trigger inserts only when the row is not there yet, never `INSERT OR IGNORE`: a trigger's
// conflict clause is overridden by the statement that fired it, and `applyOps` writes properties
// with an upsert (`ON CONFLICT ... DO UPDATE`), under which a second mark of the same block failed
// the whole write with a UNIQUE error.
const DIRTY_STATEMENTS: readonly string[] = [
  // `kind`: 'block' (created, moved or deleted: its subtree's paths may have changed), 'text'
  // (only its text, marker or properties: `reindexRefs`'s `samePlace`), 'page', or 'all' (id '*':
  // rebuild everything — a replica that had rows before it had the index).
  `CREATE TABLE IF NOT EXISTS ref_dirty (
    kind TEXT NOT NULL,
    id   TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID`,
  // Blocks: content and properties decide its own refs (and its marker, the derived `#Task`);
  // page and parent decide its path; deletion decides whether it is read at all. `order_key` and
  // `updated_at` alone change nothing the index holds, so they do not mark. Two UPDATE triggers,
  // because an edit that leaves a block where it was is the common case and the cheap one.
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_ai AFTER INSERT ON block BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'block', new.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'block' AND id = new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_au
    AFTER UPDATE OF page_id, parent_id, deleted_at ON block BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'block', new.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'block' AND id = new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_text_au
    AFTER UPDATE OF content, marker ON block BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'text', new.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'text' AND id = new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_ad AFTER DELETE ON block BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'block', old.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'block' AND id = old.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_prop_ai AFTER INSERT ON block_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'text', new.block_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'text' AND id = new.block_id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_prop_au AFTER UPDATE ON block_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'text', new.block_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'text' AND id = new.block_id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_block_prop_ad AFTER DELETE ON block_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'text', old.block_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'text' AND id = old.block_id);
  END`,
  // Pages: name/key and existence decide what references resolve to; the journal day decides the
  // intrinsic `Journal` tag; `tags::`/`alias::` live in page_prop.
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_ai AFTER INSERT ON page BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', new.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_au
    AFTER UPDATE OF name, key, journal_day, deleted_at ON page BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', new.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_ad AFTER DELETE ON page BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', old.id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = old.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_prop_ai AFTER INSERT ON page_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', new.page_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = new.page_id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_prop_au AFTER UPDATE ON page_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', new.page_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = new.page_id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ref_dirty_page_prop_ad AFTER DELETE ON page_prop BEGIN
    INSERT INTO ref_dirty(kind, id) SELECT 'page', old.page_id
      WHERE NOT EXISTS (SELECT 1 FROM ref_dirty WHERE kind = 'page' AND id = old.page_id);
  END`,
];

/**
 * The index tables, the dirty queue and its triggers, on every open (`IF NOT EXISTS`: a replica
 * has no migration table). A replica that already held pages before it had the index is queued for
 * a full rebuild — the triggers only see writes made after they exist. In one savepoint, like the
 * FTS index: half-made would read as "had it" next time and never be rebuilt. Never fatal; false
 * means references read through the server instead (`../data/store.ts#useLinkedReferences`).
 */
export function ensureClientRefIndex(driver: SqlDriver): boolean {
  driver.exec("SAVEPOINT client_ref_index");
  try {
    const had = driver.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ref_dirty'",
    );
    for (const stmt of REF_INDEX_STATEMENTS) driver.exec(stmt);
    for (const stmt of DIRTY_STATEMENTS) driver.exec(stmt);
    if (!had && driver.get("SELECT 1 FROM page LIMIT 1")) {
      driver.run("INSERT OR IGNORE INTO ref_dirty(kind, id) VALUES ('all', '*')");
    }
    driver.exec("RELEASE client_ref_index");
    return true;
  } catch {
    driver.exec("ROLLBACK TO client_ref_index");
    driver.exec("RELEASE client_ref_index");
    return false;
  }
}

export interface DrainResult {
  mode: "none" | "incremental" | "full";
  blocks: number;
  pages: number;
}

/** Bring the index up to date with every write since the last drain. Cheap when nothing changed
 * (one indexed read). Runs in its own transaction; call it before reading the index. */
export function drainRefIndex(driver: SqlDriver): DrainResult {
  if (!driver.get("SELECT 1 FROM ref_dirty LIMIT 1")) return { mode: "none", blocks: 0, pages: 0 };
  return driver.transaction(() => {
    const rows = driver.all<{ kind: string; id: string }>("SELECT kind, id FROM ref_dirty");
    const moved = new Set<string>();
    const edited = new Set<string>();
    const pages: string[] = [];
    let all = false;
    for (const r of rows) {
      if (r.kind === "block") moved.add(r.id);
      else if (r.kind === "text") edited.add(r.id);
      else if (r.kind === "page") pages.push(r.id);
      else all = true;
    }
    const blocks = new Set([...moved, ...edited]);
    const samePlace = new Set([...edited].filter((id) => !moved.has(id)));
    let mode: DrainResult["mode"];
    if (all || blocks.size > FULL_REBUILD_THRESHOLD) {
      rebuildRefIndex(driver);
      mode = "full";
    } else {
      reindexRefs(driver, blocks, pages, { samePlace });
      mode = "incremental";
    }
    // The derivation writes only the index tables, which carry no triggers: nothing it did is
    // queued again.
    driver.exec("DELETE FROM ref_dirty");
    return { mode, blocks: blocks.size, pages: pages.length };
  });
}
