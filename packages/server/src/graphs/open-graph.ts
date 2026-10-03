/**
 * "Open one graph": extracted from `cli.ts`'s old `open()` (pre-ADR-025, which only ever opened
 * `<dataDir>/graph.sqlite`) so both the simple single-graph CLI commands (`import`, `export`,
 * `token`, ...) and `graphs/registry.ts` (many graphs, one process) share exactly one
 * implementation of "open this graph's database, optionally run its data migrations." The registry
 * additionally builds a `Hono` app per graph and lazily caches handles; this function knows nothing
 * about HTTP.
 */

import { createServerContext, type ServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";
import { migrateJournalNames } from "../journal-names.js";
import type { ServerConfig } from "../ops/registry.js";
import { migrateReferencedPages } from "../ref-pages-migration.js";
import { reindexPipeAliasRefs } from "../ref-reindex.js";
import { graphDbPath, graphDir } from "./paths.js";

/** The server-wide settings every graph in one process shares — one bind port/host, not one per
 * graph. Only `dataDir`/`graphId` actually vary per graph (`ServerConfig`'s other fields). */
export type BaseServerConfig = Omit<ServerConfig, "dataDir" | "graphId">;

export interface OpenGraphOptions {
  /** Run pending data migrations (ADR 018 journal renames, ADR 024 referenced-page creation, pipe-
   * alias ref reindexing) — see the identical option on the old `cli.ts#open()` this replaced for
   * why it's opt-in: a read-only command quietly rewriting rows would be a nasty surprise. */
  migrate?: boolean;
  /** Where migration progress messages go. Defaults to `process.stderr.write`; overridable so a
   * caller managing several graphs at once (the registry) can prefix them with which graph. */
  log?: (message: string) => void;
}

export function openGraph(
  dataDir: string,
  graphId: string,
  base: BaseServerConfig,
  opts: OpenGraphOptions = {},
): { ctx: ServerContext; config: ServerConfig } {
  const log = opts.log ?? ((message: string) => process.stderr.write(message));
  const ctx = createServerContext(openDb({ path: graphDbPath(dataDir, graphId) }));
  // `config.dataDir` is the graph's OWN subdirectory, not the multi-graph root — mirror export,
  // asset storage, and plugin discovery (`pluginDirsFor`) all read it relative to this.
  const config: ServerConfig = { ...base, dataDir: graphDir(dataDir, graphId), graphId };

  if (opts.migrate) {
    const journals = migrateJournalNames(ctx);
    reindexPipeAliasRefs(ctx);
    // After both: ISO journal keys and `[[Target|label]]` keys must be right before "which
    // references resolve to nothing" can be answered (ADR 024).
    const referenced = migrateReferencedPages(ctx);
    if (referenced.created > 0) {
      log(
        `nooklet: [${graphId}] created ${referenced.created} pages the graph references (ADR 024) in ${referenced.durationMs} ms\n`,
      );
    }
    if (journals.renamed > 0) {
      log(`nooklet: [${graphId}] gave ${journals.renamed} journal pages their ISO names\n`);
    }
    for (const name of journals.collided) {
      log(
        `nooklet: [${graphId}] left journal page "${name}" alone — another page already owns that ISO name\n`,
      );
    }
  }

  return { ctx, config };
}
