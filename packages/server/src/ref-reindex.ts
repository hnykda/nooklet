/**
 * One-time re-index of `[[Target|label]]` references (B-86).
 *
 * `ref` is a derived table rebuilt per block on every write, so the fix in `core/refs.ts` is
 * complete for anything written after it. Rows written before it carry keys like "target|label"
 * with no page id; those blocks — and only those, found by the `|` in the key — are rebuilt once,
 * then a setting marks it done. Same shape as `journal-names.ts`.
 *
 * Both derived tables, not just `ref`: `path_ref` — what backlinks and backlink counts read — was
 * built FROM the old `ref` rows, for the block and every descendant. The first version of this
 * re-index rebuilt `ref` alone and left `path_ref` keyed on "target|label", so old links stayed out
 * of backlinks (B-86 follow-up). Blocks are therefore found through either table and rebuilt the
 * way every write rebuilds them (`reindexBlockAndSubtree`), and the done-flag is a new key: a graph
 * that ran the first version has clean `ref` rows but stale `path_ref` rows, and must run again.
 * A page whose own name contains `|` makes its blocks candidates too; rebuilding them is a no-op.
 */

import { reindexBlockAndSubtree, type ServerContext } from "./apply-ops.js";

const DONE_KEY = "refs.pipe_alias.path_ref";

/** Returns how many blocks were re-indexed; 0 when already done. */
export function reindexPipeAliasRefs(ctx: ServerContext): number {
  const { driver } = ctx;
  if (driver.get("SELECT 1 FROM setting WHERE key = ?", [DONE_KEY])) return 0;
  const blocks = driver.all<{ id: string }>(
    `SELECT r.src_block_id AS id FROM ref r JOIN block b ON b.id = r.src_block_id
      WHERE r.dst_page_key LIKE '%|%'
     UNION
     SELECT pr.block_id AS id FROM path_ref pr JOIN block b ON b.id = pr.block_id
      WHERE pr.page_key LIKE '%|%'`,
  );
  driver.transaction(() => {
    for (const b of blocks) reindexBlockAndSubtree(driver, b.id);
    driver.run(
      `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc) VALUES (?, 'default', 'true', ?, ?)`,
      [DONE_KEY, Date.now(), ctx.hlc.next()],
    );
  });
  return blocks.length;
}
