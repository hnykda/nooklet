/**
 * The reference index: `ref` (what each block's own text and properties link to), `path_ref`
 * (sql-schema.md rule 12: a block's own refs, its ancestors' refs and its page — what linked
 * references read), plus the page-level `page_tag` (ADR 017) and `page_alias` (rule 6) indexes it
 * resolves through. All four are derived: rebuilt from current state, never written by hand.
 *
 * In core, not in the server, because two kinds of host keep it now. The server re-derives it in
 * `serverApplyOps` on every write. A client replica keeps the same tables (B-641) so linked and
 * unlinked references, the filters and counts the panel shows, answer from the device offline and
 * in local-only mode — the same SQL over the same rows gives the same answer as the server's
 * `page.backlinks`, because it IS the same code. Platform-free: only a `SqlDriver`.
 */

import { canonicalRefName } from "../journal.js";
import { normalizePageName } from "../page-name.js";
import { extractRefs, TASK_TAG } from "../refs.js";
import { type ChildRow, childLookup } from "./block-children.js";
import type { SqlDriver } from "./driver.js";
import {
  rebuildPageAliases,
  reindexPageIdentity,
  reresolveIndexTargets,
  resolvePageIdForKey,
} from "./page-alias-index.js";
import { rebuildPageTags } from "./page-tag-index.js";

/**
 * The four tables and their indexes, `IF NOT EXISTS` so a host can run them on every open. The
 * server's own DDL (`packages/server/src/schema.ts`) declares the same shapes for a fresh graph and
 * migrates old ones; `packages/server/src/ref-index-ddl.test.ts` asserts the two agree, so a column
 * added on one side cannot be forgotten on the other.
 */
export const REF_INDEX_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ref (
    id           INTEGER PRIMARY KEY,
    src_block_id TEXT NOT NULL REFERENCES block(id),
    src_page_id  TEXT NOT NULL REFERENCES page(id),
    kind         TEXT NOT NULL CHECK (kind IN ('page','tag','block','embed')),
    dst_page_key TEXT,
    dst_page_id  TEXT,
    dst_block_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ref_src ON ref(src_block_id)`,
  `CREATE INDEX IF NOT EXISTS ref_dst_page_key ON ref(dst_page_key) WHERE dst_page_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ref_dst_block ON ref(dst_block_id) WHERE dst_block_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ref_dst_page_id ON ref(dst_page_id) WHERE dst_page_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS path_ref (
    block_id TEXT NOT NULL REFERENCES block(id),
    page_key TEXT NOT NULL,
    page_id  TEXT,
    PRIMARY KEY (block_id, page_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS path_ref_page_key ON path_ref(page_key)`,
  `CREATE INDEX IF NOT EXISTS path_ref_page_id ON path_ref(page_id) WHERE page_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS page_tag (
    page_id     TEXT NOT NULL REFERENCES page(id),
    tag_key     TEXT NOT NULL,
    tag_page_id TEXT,
    source      TEXT NOT NULL CHECK (source IN ('property','intrinsic')),
    PRIMARY KEY (page_id, tag_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS page_tag_key ON page_tag(tag_key)`,
  `CREATE INDEX IF NOT EXISTS page_tag_page ON page_tag(tag_page_id) WHERE tag_page_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS page_alias (
    page_id   TEXT NOT NULL REFERENCES page(id),
    alias_key TEXT NOT NULL,
    PRIMARY KEY (page_id, alias_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS page_alias_key ON page_alias(alias_key)`,
];

/**
 * Re-derive the index for exactly these blocks and pages. `ref` for every block first, then
 * `path_ref` once for the union of their subtrees — a descendant's path reads its ancestors' `ref`
 * rows, and a batch that moves a subtree touches every block in it, so rebuilding each block's
 * whole subtree per block was O(n·depth) walks. Pages after blocks: a page write can change what a
 * name resolves to, and a batch that creates a page and a block linking it must end up resolved.
 *
 * Idempotent, and cheap to call for an id that no longer exists (its rows go). Returns the blocks
 * that do exist, for a host that queues further work per block (the server's `embed_dirty`).
 */
export function reindexRefs(
  driver: SqlDriver,
  blockIds: Iterable<string>,
  pageIds: Iterable<string>,
): string[] {
  const children = childLookup(driver);
  const indexed: string[] = [];
  const blocks = [...blockIds];
  for (const blockId of blocks) if (indexBlockRefs(driver, blockId)) indexed.push(blockId);
  const pathBlocks = new Set<string>();
  for (const blockId of blocks) {
    if (pathBlocks.has(blockId)) continue; // reached from an ancestor's walk, subtree included
    for (const id of subtreeIds(blockId, children)) pathBlocks.add(id);
  }
  for (const id of pathBlocks) rebuildPathRef(driver, id);
  for (const pageId of pageIds) {
    // Page-level tags come from the page's `tags` property and its journal day (ADR 017); its
    // aliases from `alias::`; and a create, rename or delete changes what names resolve to.
    rebuildPageTags(driver, pageId);
    reindexPageIdentity(driver, pageId);
  }
  return indexed;
}

/**
 * Throw the whole index away and derive it again from every page and block. For a host that has
 * rows the index never saw — a client replica that predates the tables, or one bootstrapped from a
 * snapshot — and for tests comparing it with the incremental path.
 */
export function rebuildRefIndex(driver: SqlDriver): void {
  driver.exec("DELETE FROM ref");
  driver.exec("DELETE FROM path_ref");
  driver.exec("DELETE FROM page_tag");
  driver.exec("DELETE FROM page_alias");
  const pages = driver.all<{ id: string }>("SELECT id FROM page").map((r) => r.id);
  // Aliases before any ref is resolved: `resolvePageIdForKey` reads `page_alias`.
  for (const id of pages) rebuildPageAliases(driver, id);
  const blocks = driver.all<{ id: string }>("SELECT id FROM block").map((r) => r.id);
  for (const id of blocks) indexBlockRefs(driver, id);
  // Every block is in the set, so one path walk each — no subtree walks needed.
  for (const id of blocks) rebuildPathRef(driver, id);
  for (const id of pages) rebuildPageTags(driver, id);
  // `rebuildPageTags` resolves a tag by own key only; the incremental path then re-resolves every
  // key through aliases too (`reindexPageIdentity`). Same end state, in one pass.
  reresolveIndexTargets(driver);
}

/** Recompute `ref` for one block and `path_ref` for it and every descendant (sql-schema.md rule
 * 12). For a one-time re-index of blocks found by their stale rows (`ref-reindex.ts`). */
export function reindexBlockAndSubtree(
  driver: SqlDriver,
  blockId: string,
  children: (parentId: string) => ChildRow[] = childLookup(driver),
): void {
  if (!indexBlockRefs(driver, blockId)) return;
  for (const id of subtreeIds(blockId, children)) rebuildPathRef(driver, id);
}

/** `ref` rows for one block; false (and its derived rows gone) when the block does not exist.
 * `path_ref` is the caller's, because it spans the subtree. */
function indexBlockRefs(driver: SqlDriver, blockId: string): boolean {
  const block = driver.get<{ id: string; page_id: string; content: string }>(
    "SELECT id, page_id, content FROM block WHERE id = ?",
    [blockId],
  );
  if (!block) {
    // Block never existed (a rejected create) or was hard-deleted: nothing to index.
    driver.run("DELETE FROM ref WHERE src_block_id = ?", [blockId]);
    driver.run("DELETE FROM path_ref WHERE block_id = ?", [blockId]);
    return false;
  }
  rebuildRefRows(driver, block.id, block.page_id, block.content);
  return true;
}

export function rebuildRefRows(
  driver: SqlDriver,
  blockId: string,
  pageId: string,
  content: string,
): void {
  driver.run("DELETE FROM ref WHERE src_block_id = ?", [blockId]);
  const props = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
    [blockId],
  );
  const properties: Record<string, string> = {};
  for (const p of props) if (p.value !== null) properties[p.key] = p.value;
  const extracted = extractRefs(content, properties);

  const insert = (kind: "page" | "tag", key: string): void => {
    const pageKey = normalizeKey(key);
    driver.run(
      "INSERT INTO ref(src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id) VALUES (?, ?, ?, ?, ?, NULL)",
      [blockId, pageId, kind, pageKey, resolvePageIdForKey(driver, pageKey)],
    );
  };
  for (const p of extracted.pageRefs) insert("page", p);
  for (const t of extracted.tags) insert("tag", t);

  // A block with a task marker also refs the `Task` page, so tasks live in the same reference
  // machinery as everything else: `[[Task]]` lists them all, a tag query finds them, and nothing
  // has to special-case "tasks" as a separate concept.
  //
  // DERIVED from `block.marker` rather than written into the block's text as a literal `#Task`.
  // Writing it would put the same fact in two places that can disagree — delete the tag and you
  // have a task that is not a Task; change the marker by hand in the markdown mirror and the tag
  // is stale. Here the marker stays the single source of truth and the tag is a projection of it,
  // rebuilt on every write. Note the block is re-read from the database above, so the marker is
  // already current by the time this runs.
  const marked = driver.get<{ marker: string | null }>("SELECT marker FROM block WHERE id = ?", [
    blockId,
  ]);
  if (marked?.marker) insert("tag", TASK_TAG);
  for (const blockRefId of extracted.blockRefs) {
    const target = driver.get<{ id: string; page_id: string }>(
      "SELECT id, page_id FROM block WHERE id = ?",
      [blockRefId],
    );
    const dstPage = target
      ? driver.get<{ key: string }>("SELECT key FROM page WHERE id = ?", [target.page_id])
      : undefined;
    driver.run(
      "INSERT INTO ref(src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id) VALUES (?, ?, 'block', ?, ?, ?)",
      [blockId, pageId, dstPage?.key ?? null, target?.page_id ?? null, blockRefId],
    );
  }
}

/**
 * The key a reference is indexed under. Case and whitespace are folded as ever; on top of that a
 * journal day written in any recognised title format collapses to its ISO name (ADR 018), so
 * `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` are one reference and land in
 * one backlinks list — and all three resolve to the page, which is stored under the ISO name.
 */
function normalizeKey(name: string): string {
  return normalizePageName(canonicalRefName(name));
}

/** The block and every descendant, tombstoned ones included. Through `childLookup`, not a bare
 * `WHERE parent_id = ?`: that cannot use the partial `block_children` index and scanned the whole
 * table once per visited block (`./block-children.ts`). */
function subtreeIds(rootId: string, children: (parentId: string) => ChildRow[]): string[] {
  const ids: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    for (const c of children(parent)) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

function rebuildPathRef(driver: SqlDriver, blockId: string): void {
  driver.run("DELETE FROM path_ref WHERE block_id = ?", [blockId]);
  const keys = new Map<string, string | null>();
  let cur = driver.get<{ id: string; page_id: string; parent_id: string | null }>(
    "SELECT id, page_id, parent_id FROM block WHERE id = ?",
    [blockId],
  );
  if (!cur) return;
  const page = driver.get<{ key: string; id: string }>("SELECT key, id FROM page WHERE id = ?", [
    cur.page_id,
  ]);
  if (page) keys.set(page.key, page.id);

  let guard = 0;
  while (cur && guard++ < 1000) {
    const selfRefs = driver.all<{ dst_page_key: string | null; dst_page_id: string | null }>(
      "SELECT DISTINCT dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? AND dst_page_key IS NOT NULL",
      [cur.id],
    );
    for (const r of selfRefs) if (r.dst_page_key) keys.set(r.dst_page_key, r.dst_page_id);
    cur = cur.parent_id
      ? driver.get<{ id: string; page_id: string; parent_id: string | null }>(
          "SELECT id, page_id, parent_id FROM block WHERE id = ?",
          [cur.parent_id],
        )
      : undefined;
  }
  for (const [key, pageId] of keys) {
    driver.run("INSERT OR IGNORE INTO path_ref(block_id, page_key, page_id) VALUES (?, ?, ?)", [
      blockId,
      key,
      pageId,
    ]);
  }
}
