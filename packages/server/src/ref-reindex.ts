/**
 * One-time re-index of `[[Target|label]]` references (B-86).
 *
 * `ref` is a derived table rebuilt per block on every write, so the fix in `core/refs.ts` is
 * complete for anything written after it. Rows written before it carry `dst_page_key` values like
 * "target|label" with no `dst_page_id`; those blocks — and only those, found by the `|` in the
 * key — are rebuilt once, then a setting marks it done. Same shape as `journal-names.ts`.
 */

import { rebuildRefRows, type ServerContext } from "./apply-ops.js";

const DONE_KEY = "refs.pipe_alias";

/** Returns how many blocks were re-indexed; 0 when already done. */
export function reindexPipeAliasRefs(ctx: ServerContext): number {
  const { driver } = ctx;
  if (driver.get("SELECT 1 FROM setting WHERE key = ?", [DONE_KEY])) return 0;
  const blocks = driver.all<{ id: string; page_id: string; content: string }>(
    `SELECT DISTINCT b.id, b.page_id, b.content
       FROM ref r JOIN block b ON b.id = r.src_block_id
      WHERE r.dst_page_key LIKE '%|%'`,
  );
  driver.transaction(() => {
    for (const b of blocks) rebuildRefRows(driver, b.id, b.page_id, b.content);
    driver.run(
      `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc) VALUES (?, 'default', 'true', ?, ?)`,
      [DONE_KEY, Date.now(), ctx.hlc.next()],
    );
  });
  return blocks.length;
}
