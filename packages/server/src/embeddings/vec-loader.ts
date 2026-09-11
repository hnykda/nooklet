/**
 * Loads the `sqlite-vec` extension into the raw `node:sqlite` connection `db.ts` opens, and
 * remembers whether it worked so the rest of the embeddings subsystem (model registry, search,
 * indexer, CLI) can degrade gracefully instead of throwing deep inside a KNN query.
 *
 * Verified recipe (`docs/research/06-embeddings.md` §2.1, this machine, Node 26.8.1):
 *   const db = new DatabaseSync(path, { allowExtension: true });
 *   sqliteVec.load(db); db.enableLoadExtension(false);
 *   db.prepare('select vec_version() v').get(); // { v: 'v0.1.9' }
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "@nooklet/core";

export interface VecStatus {
  loaded: boolean;
  version?: string;
  error?: string;
}

/**
 * Load `sqlite-vec` into a raw `DatabaseSync` opened with `{ allowExtension: true }`
 * (`openNodeSqlite(path, { allowExtension: true })`), then lock extension loading back down.
 * Must be called on the raw connection, before wrapping it with `createNodeSqliteDriver` —
 * `loadExtension`/`enableLoadExtension` aren't part of the storage-agnostic `SqlDriver` interface.
 */
export function loadSqliteVec(db: DatabaseSync): VecStatus {
  try {
    // `sqlite-vec` normally locates its per-platform `vec0` dylib by resolving a sibling package
    // out of `node_modules`, which does not exist inside a packaged desktop app. The env var is
    // the seam for that case: the desktop build ships the dylib as an app resource and points
    // here (`apps/desktop`). Required lazily so a bundler can drop the package entirely when the
    // path is supplied.
    const override = process.env.NOOKLET_SQLITE_VEC_PATH;
    if (override) {
      db.loadExtension(override);
    } else {
      const sqliteVec = createRequire(import.meta.url)("sqlite-vec") as {
        load(db: DatabaseSync): void;
      };
      sqliteVec.load(db);
    }
    db.enableLoadExtension(false);
    const row = db.prepare("select vec_version() v").get() as { v: string } | undefined;
    return { loaded: true, version: row?.v };
  } catch (err) {
    return { loaded: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// One `SqlDriver` instance == one open connection; a WeakMap keeps the vec-load outcome attached
// to it without adding a field to the storage-agnostic `SqlDriver` interface itself (that
// interface is shared with the browser build, which never loads native extensions at all).
const statusByDriver = new WeakMap<SqlDriver, VecStatus>();

export function setVecStatus(driver: SqlDriver, status: VecStatus): void {
  statusByDriver.set(driver, status);
}

/** Never throws. Callers that need vectors MUST check `.loaded` and soft-fail (search falls back
 * to keyword; the model registry refuses to register a new model; the CLI reports the reason). */
export function getVecStatus(driver: SqlDriver): VecStatus {
  return (
    statusByDriver.get(driver) ?? {
      loaded: false,
      error: "sqlite-vec status unknown: this driver was not opened via db.ts's openDb()",
    }
  );
}
