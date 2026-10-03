/**
 * One-time migration from the pre-ADR-025 flat layout (`<dataDir>/graph.sqlite` +
 * `<dataDir>/{pages,journals,assets}/` directly) to the nested one (`<dataDir>/graphs/default/...`).
 *
 * Runs as a pure filesystem move, before any `openDb` call — migration tracking everywhere else in
 * this package (`db.ts`'s `PRAGMA user_version`/`schema_migration`) is DB-internal and needs an
 * already-open driver, which is exactly what a directory-layout migration has to run ahead of,
 * since the driver's own path depends on this having already happened. Idempotent: does nothing
 * once `<dataDir>/graphs/` exists, so it's safe to call unconditionally on every startup.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GraphMeta, graphDir, graphMetaPath, graphsRootDir, legacyDbPath } from "./paths.js";

/** Directories that make up a graph's on-disk footprint besides the database file itself, per
 * ADR 025 (mirror + assets both fold in unchanged — see the ADR's storage layout section). */
const SIDECAR_DIRS = ["pages", "journals", "assets"] as const;

export interface MigrateLegacyLayoutResult {
  migrated: boolean;
  /** The graph id the legacy content was folded into. Always `"default"` when `migrated` is true. */
  graphId?: string;
}

export function migrateLegacyLayoutIfNeeded(dataDir: string): MigrateLegacyLayoutResult {
  if (existsSync(graphsRootDir(dataDir))) return { migrated: false };
  if (!existsSync(legacyDbPath(dataDir))) return { migrated: false };

  const graphId = "default";
  const target = graphDir(dataDir, graphId);
  mkdirSync(target, { recursive: true });
  renameSync(legacyDbPath(dataDir), join(target, "graph.sqlite"));
  for (const name of SIDECAR_DIRS) {
    const from = join(dataDir, name);
    if (existsSync(from)) renameSync(from, join(target, name));
  }
  // Without this, `GraphRegistry.list()` (which only recognizes a directory as a real graph once
  // it has a `graph.json` — see its own doc comment) would never see the graph this migration just
  // produced, and `serve`'s "create a default graph if none exists yet" bootstrap would then try to
  // create ANOTHER one at the same path and fail, since the database is already there.
  const meta: GraphMeta = { id: graphId, label: graphId, createdAt: Date.now() };
  writeFileSync(graphMetaPath(dataDir, graphId), JSON.stringify(meta, null, 2));
  return { migrated: true, graphId };
}
