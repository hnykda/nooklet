/**
 * `GET /sync/snapshot` (ADR 003 / research/03-sync.md §6.5): the bootstrap path for a brand-new
 * device — the current *state* (every row of the four sync state tables: `page`, `block`,
 * `block_prop`, `page_prop`) plus the `cursor` (max `op.seq`) it is consistent with, so a fresh
 * client can populate its replica in one shot instead of replaying the whole op log.
 *
 * Pagination choice: NONE — this returns all four tables as one JSON body. The task-scale target
 * (952 pages / 18,628 blocks, `docs/spec/sql-schema.md` rule 28) is a few thousand rows per table,
 * comfortably inside "a single JSON blob is acceptable if you keep it under control": at the
 * documented ~15-25 MB *client replica* size for that graph, the four state tables alone (no
 * `op`/`changes`/`embedding*`/FTS) are a small fraction of that, well under typical body-size
 * limits. A cursor-paginated version would also have to keep the four tables' pages consistent
 * with each other AND with `cursor` across several HTTP round trips while the graph keeps
 * accepting writes in between — the "one savepoint" requirement below only buys that consistency
 * for a single response, not a multi-request pagination sequence, so paginating here would need a
 * held-open transaction across requests (a real cost) to actually keep the guarantee this route
 * exists to provide. Revisit if/when a real graph makes one response too large in practice.
 *
 * Every row of every table is included, not just `deleted_at IS NULL` rows: a fresh replica needs
 * tombstones and their `_hlc` columns too, exactly like `rebuild()` does (`docs/spec/sql-schema.md`
 * rule 26) — otherwise a later, older-HLC op arriving via `/sync/pull` could incorrectly "win"
 * against a delete/removal the replica never learned about.
 */

import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { requireSyncToken } from "./auth.js";

export function registerSyncSnapshot(app: Hono, serverCtx: ServerContext): void {
  app.get("/sync/snapshot", (c) => {
    const auth = requireSyncToken(c, serverCtx.driver);
    if (auth instanceof Response) return auth;

    const { driver } = serverCtx;
    const snapshot = driver.transaction(() => {
      const cursor = driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")?.n ?? 0;
      return {
        cursor,
        pages: driver.all("SELECT * FROM page"),
        blocks: driver.all("SELECT * FROM block"),
        blockProps: driver.all("SELECT * FROM block_prop"),
        pageProps: driver.all("SELECT * FROM page_prop"),
      };
    });

    return c.json({
      cursor: snapshot.cursor,
      pages: snapshot.pages,
      blocks: snapshot.blocks,
      block_props: snapshot.blockProps,
      page_props: snapshot.pageProps,
    });
  });
}
