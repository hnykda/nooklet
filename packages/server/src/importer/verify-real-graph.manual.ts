/**
 * Manual sanity script — NOT part of `pnpm vitest run` (the filename doesn't match vitest's
 * default `*.test.ts`/`*.spec.ts` pattern on purpose). The automated suite (`logseq.test.ts`)
 * only ever imports synthetic fixture graphs built under a temp dir; this script is the
 * complementary manual check against a real graph, run by hand when useful.
 *
 * Imports a real Logseq file graph into a scratch SQLite file and prints ONLY aggregate counts —
 * never a page name, block content, or the text of any warning/error (a warning can embed a file
 * path, which is itself a page's title) — so it's safe to run and paste the output anywhere.
 *
 * Usage: pnpm tsx src/importer/verify-real-graph.manual.ts [graphDir]
 *   graphDir defaults to ~/notes-graph.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";
import { importLogseqGraph } from "./logseq.js";

const graphDir = process.argv[2] ?? "~/notes-graph";
const scratchDir = mkdtempSync(join(tmpdir(), "nooklet-logseq-verify-"));
const dbPath = join(scratchDir, "graph.sqlite");

async function main(): Promise<void> {
  const ctx = createServerContext(openDb({ path: dbPath }));
  const stats = await importLogseqGraph(ctx, graphDir);

  const pageRows = ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM page")?.n ?? 0;
  const blockRows = ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM block")?.n ?? 0;

  console.log(
    JSON.stringify(
      {
        graphDir,
        dbPageRows: pageRows,
        dbBlockRows: blockRows,
        pagesImported: stats.pagesImported,
        journalsImported: stats.journalsImported,
        blocksImported: stats.blocksImported,
        pagesSkipped: stats.pagesSkipped,
        danglingBlockRefs: stats.danglingBlockRefs,
        warningCount: stats.warnings.length,
        errorCount: stats.errors.length,
        durationMs: stats.durationMs,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err: unknown) => {
    console.error("import failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });
