/**
 * One-time upgrade of a graph written before ADR 024: every reference that still resolves to
 * nothing gets its page, with its namespace ancestors, as real `page.create` ops. Same shape as
 * `./journal-names.ts` — a startup task guarded by a `setting` row rather than a `schema.ts`
 * migration, because the pages must be ops (an `INSERT INTO page` would be state the op log cannot
 * reproduce: `nooklet verify` would flag it, and no device would ever hear of the pages).
 *
 * The rules are `./ref-pages.ts`'s own (`WantedPages`): page links and tags in live blocks on live
 * pages, property values except `alias::`, the derived `Task` tag, `tags::` on pages, namespace
 * ancestors of every live page, never a journal day. A name takes the casing of its earliest
 * referencing block (`block.created_at`, then id — the order the graph was written in), and that
 * block's (or page's) creation time as its own: `page.updated_at` never moves after a create, and
 * "Recently edited" sorts by it (B-446).
 *
 * The importer runs `mintDanglingReferencedPages` itself once all files are in: it writes with
 * minting off (`referencedPages: "skip"`), because page A's `[[B]]` would otherwise mint B before
 * B's own file arrives and make B's `page.create` collide.
 */

import { makeOp, type Op } from "@nooklet/core";
import { type ServerContext, serverApplyOps } from "./apply-ops.js";
import { REFERENCE_DEVICE_ID, referencePageOps, WantedPages } from "./ref-pages.js";

const DONE_KEY = "refs.pages_exist";

/** Ops per `serverApplyOps` call — one call per page would re-run the planner 250 times. */
const CHUNK = 500;

export interface ReferencedPagesMigration {
  /** Pages created. */
  created: number;
  /** The first few names, for the startup log. */
  sample: string[];
  durationMs: number;
  alreadyDone: boolean;
}

/**
 * Create every page the graph references and does not have. Ungated: idempotent, and a no-op on a
 * graph with nothing dangling. `migrateReferencedPages` is the gated form startup uses.
 */
export function mintDanglingReferencedPages(ctx: ServerContext): ReferencedPagesMigration {
  const start = Date.now();
  const { driver } = ctx;
  const wanted = new WantedPages(driver);

  // Each page is dated by its earliest reference, not by this sweep (B-446).
  const blocks = driver.all<{ id: string; created_at: number }>(
    `SELECT b.id AS id, b.created_at AS created_at FROM block b
       JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE b.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM ref r WHERE r.src_block_id = b.id AND r.dst_page_id IS NULL
                     AND r.kind IN ('page', 'tag'))
     ORDER BY b.created_at, b.id`,
  );
  for (const b of blocks) wanted.wantFromBlock(b.id, b.created_at);

  for (const p of driver.all<{ id: string; name: string; created_at: number }>(
    `SELECT id, name, created_at FROM page WHERE deleted_at IS NULL
       AND (instr(name, '/') > 0 OR EXISTS (
             SELECT 1 FROM page_tag pt WHERE pt.page_id = page.id AND pt.source = 'property'
               AND pt.tag_page_id IS NULL))
     ORDER BY created_at, id`,
  )) {
    wanted.wantFromPage(p.id, p.name, p.created_at);
  }

  const ops = referencePageOps(wanted, new Set(), (entity, payload) =>
    makeOp(ctx.hlc.next(), REFERENCE_DEVICE_ID, entity, payload),
  );
  for (let i = 0; i < ops.length; i += CHUNK) {
    const chunk: Op[] = ops.slice(i, i + CHUNK);
    serverApplyOps(ctx, chunk, { origin: "system", actor: "migration:referenced-pages" });
  }
  return {
    created: wanted.byKey.size,
    sample: [...wanted.byKey.values()].slice(0, 10),
    durationMs: Date.now() - start,
    alreadyDone: false,
  };
}

/** ADR 024 for a graph that predates it, once; one `setting` read on every start after that. */
export function migrateReferencedPages(ctx: ServerContext): ReferencedPagesMigration {
  const { driver } = ctx;
  if (driver.get("SELECT 1 FROM setting WHERE key = ?", [DONE_KEY])) {
    return { created: 0, sample: [], durationMs: 0, alreadyDone: true };
  }
  const result = mintDanglingReferencedPages(ctx);
  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc)
     VALUES (?, 'default', ?, ?, '')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [DONE_KEY, JSON.stringify({ at: Date.now(), created: result.created }), Date.now()],
  );
  return result;
}
