/**
 * Probe (2026-09-13, m11/ref-pages, ADR 024): the one-time "pages exist once referenced" migration
 * on a real graph. Runs the startup migrations in `cli.ts#open`'s order, then reports: dangling
 * reference keys and rows before and after, pages created (with a sample), the time the migration
 * took, how many keys are still dangling and why (journal days are left alone by design), and the
 * `verify` replay result.
 *
 * Run against a COPY of a graph (it writes):
 *   pnpm --filter @nooklet/server exec tsx ../../tools/probes/ref-pages-migration-real-graph.ts <copy>/graph.sqlite
 */

import { parseJournalTitle } from "../../packages/core/src/index.ts";
import { createServerContext } from "../../packages/server/src/apply-ops.ts";
import { openDb } from "../../packages/server/src/db.ts";
import { migrateJournalNames } from "../../packages/server/src/journal-names.ts";
import { migrateReferencedPages } from "../../packages/server/src/ref-pages-migration.ts";
import { reindexPipeAliasRefs } from "../../packages/server/src/ref-reindex.ts";
import { verifyRebuildParity } from "../../packages/server/src/verify.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: ref-pages-migration-real-graph.ts <copy of graph.sqlite>");
const ctx = createServerContext(openDb({ path }));
const { driver } = ctx;

const dangling = () =>
  driver.get<{ keys: number; rows: number }>(
    `SELECT COUNT(DISTINCT dst_page_key) AS keys, COUNT(*) AS rows FROM ref
     WHERE dst_page_id IS NULL AND dst_page_key IS NOT NULL AND kind IN ('page', 'tag')`,
  );
const livePages = () =>
  driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM page WHERE deleted_at IS NULL")?.n ?? 0;

console.log(`before: ${livePages()} live pages; dangling ${JSON.stringify(dangling())}`);
migrateJournalNames(ctx);
reindexPipeAliasRefs(ctx);
const t0 = performance.now();
const result = migrateReferencedPages(ctx);
const ms = Math.round(performance.now() - t0);
console.log(
  `migrateReferencedPages: created ${result.created} pages in ${ms} ms (reported ${result.durationMs} ms); sample ${JSON.stringify(result.sample)}`,
);
console.log(`after: ${livePages()} live pages; dangling ${JSON.stringify(dangling())}`);

const left = driver.all<{ k: string; n: number; live: number }>(
  `SELECT r.dst_page_key AS k, COUNT(*) AS n,
          SUM(CASE WHEN b.deleted_at IS NULL AND p.deleted_at IS NULL THEN 1 ELSE 0 END) AS live
   FROM ref r JOIN block b ON b.id = r.src_block_id JOIN page p ON p.id = b.page_id
   WHERE r.dst_page_id IS NULL AND r.dst_page_key IS NOT NULL AND r.kind IN ('page', 'tag')
   GROUP BY r.dst_page_key ORDER BY n DESC`,
);
const journalKeys = left.filter((r) => parseJournalTitle(r.k) !== null);
const deadOnly = left.filter((r) => parseJournalTitle(r.k) === null && r.live === 0);
const unexplained = left.filter((r) => parseJournalTitle(r.k) === null && r.live > 0);
console.log(
  `still dangling: ${left.length} keys — ${journalKeys.length} journal days (by design), ` +
    `${deadOnly.length} referenced only from deleted blocks/pages, ${unexplained.length} unexplained ${JSON.stringify(unexplained.slice(0, 10))}`,
);
const namespaced = driver.all<{ name: string }>(
  "SELECT name FROM page WHERE deleted_at IS NULL AND name IN ('Sprouts', 'Sprouts/Growing', 'Task', 'quick capture', 'Quick capture', 'Quick Capture')",
);
console.log(`spot check: ${JSON.stringify(namespaced.map((r) => r.name))}`);

const second = migrateReferencedPages(ctx);
console.log(`second run: ${JSON.stringify(second)}`);

const report = verifyRebuildParity(driver);
console.log(
  `verify: ok=${report.ok} ops=${report.opCount} rejectedSkipped=${report.rejectedSkipped} divergences=${report.divergences.length} in ${report.durationMs} ms`,
);
