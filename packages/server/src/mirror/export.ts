/**
 * ADR 002 export direction: SQLite -> markdown mirror.
 *
 * Renders a page's live block tree (`page`/`block`/`block_prop`/`page_prop`, queried directly —
 * see the module header note below on why this does not go through a `DataApi`) into the
 * canonical outline format (`packages/core/src/outline.ts`'s `serializeOutline`), writes it
 * atomically under the server's data directory, and records the write's content hash in
 * `mirror_file` (`docs/spec/sql-schema.md` rule 23) so a future file watcher can tell its own
 * writes apart from a real external edit (`isOwnWrite`, below).
 *
 * Queries `SqlDriver` directly rather than going through `data-api.ts`: it needs a whole page's
 * blocks and properties in four queries, not one round trip per block.
 *
 * The render itself (the four queries, reserved columns reconstituted as property lines) is
 * `@nooklet/core`'s `sync/page-outline.ts`, shared with the web client's page export (B-220).
 *
 * Not here: a live `chokidar` watcher that turns external file edits back into ops, using
 * `isOwnWrite` below to skip echoes of our own writes, plus whatever debounce (ADR 002: ~500ms
 * after a write) decides WHEN to call `exportPage`. Both are caller concerns; this file only
 * provides the render/write/hash primitives.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  pageMirrorPath,
  type RenderedPage,
  readPageOutline,
  type SqlDriver,
  serializeOutline,
} from "@nooklet/core";

export type { RenderedPage } from "@nooklet/core";

export interface ExportResult {
  /** Path relative to the mirror root, forward-slash separated (matches `mirror_file.path`). */
  path: string;
  contentHash: string;
  changed: boolean;
}

export interface ExportAllResult {
  exported: number;
  skipped: number;
  deleted: number;
}

export interface ExportAllOptions {
  /**
   * When true, skip pages that could not possibly have changed since their last export (no
   * live block or the page row itself touched after `mirror_file.written_at`) without even
   * rendering them. Purely a perf fast path — `exportPage` already no-ops on an unchanged
   * render regardless of this flag, so results are identical either way, just cheaper to reach
   * on a large graph where most pages are untouched between calls.
   */
  onlyChanged?: boolean;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a page's row plus its full live block tree and build the `ParsedPage` tree
 * `serializeOutline` expects. The queries and the build live in `@nooklet/core`
 * (`sync/page-outline.ts`) because the web client renders the same text from its replica for
 * "Export page as markdown" (B-220). Throws if `pageId` does not name a live (non-deleted) page —
 * callers (`exportPage`/`exportAll`) only ever call this for pages they've already confirmed are
 * live.
 */
export function renderPageToOutline(driver: SqlDriver, pageId: string): RenderedPage {
  const rendered = readPageOutline(driver, pageId);
  if (!rendered) throw new Error(`renderPageToOutline: no live page with id ${pageId}`);
  return rendered;
}

/** Mirror-relative file path for a page (PLAN.md sec. 5). Forward-slash, relative to the data dir. */
export const pageFilePath = pageMirrorPath;

/**
 * Render + write one page's mirror file, skipping the write entirely when the rendered content
 * hash matches what `mirror_file` already recorded for this page (echo-suppression bookkeeping,
 * ADR 002). Writes atomically (`<path>.tmp-<random>` then `fs.rename`). If the page's file path
 * changed since the last export (a rename), the old file and its stale `mirror_file` row are
 * removed.
 */
export function exportPage(driver: SqlDriver, dataDir: string, pageId: string): ExportResult {
  const rendered = renderPageToOutline(driver, pageId);
  const relPath = pageFilePath(rendered);
  const text = serializeOutline(rendered.parsed);
  const contentHash = sha256Hex(text);

  const existing = driver.get<{ path: string; content_hash: string }>(
    "SELECT path, content_hash FROM mirror_file WHERE page_id = ?",
    [pageId],
  );

  if (existing && existing.path === relPath && existing.content_hash === contentHash) {
    return { path: relPath, contentHash, changed: false };
  }

  const absPath = join(dataDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = join(dirname(absPath), `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, text, "utf8");
  renameSync(tmpPath, absPath);

  if (existing && existing.path !== relPath) {
    const oldAbsPath = join(dataDir, existing.path);
    try {
      unlinkSync(oldAbsPath);
    } catch {
      // Old file already gone (manually deleted, or a previous export already cleaned it up).
    }
  }

  const now = Date.now();
  driver.transaction(() => {
    if (existing && existing.path !== relPath) {
      driver.run("DELETE FROM mirror_file WHERE path = ?", [existing.path]);
    }
    driver.run(
      `INSERT INTO mirror_file(path, page_id, content_hash, written_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         page_id = excluded.page_id, content_hash = excluded.content_hash, written_at = excluded.written_at`,
      [relPath, pageId, contentHash, now],
    );
  });

  return { path: relPath, contentHash, changed: true };
}

/**
 * Export every live page, then clean up mirror files for pages that are no longer live: soft
 * deleted (`page.deleted_at IS NOT NULL`, `mirror_file` row still present) or hard-gone (the
 * page id no longer exists in `page` at all).
 */
export function exportAll(
  driver: SqlDriver,
  dataDir: string,
  opts: ExportAllOptions = {},
): ExportAllResult {
  const allLivePages = driver.all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL");

  const candidates = opts.onlyChanged
    ? driver.all<{ id: string }>(
        `SELECT p.id AS id
         FROM page p
         LEFT JOIN mirror_file mf ON mf.page_id = p.id
         LEFT JOIN (
           SELECT page_id,
                  MAX(updated_at) AS last_update,
                  MAX(COALESCE(deleted_at, 0)) AS last_delete
           FROM block GROUP BY page_id
         ) b ON b.page_id = p.id
         WHERE p.deleted_at IS NULL
           AND (
             mf.path IS NULL
             OR p.updated_at > mf.written_at
             OR COALESCE(b.last_update, 0) > mf.written_at
             OR COALESCE(b.last_delete, 0) > mf.written_at
           )`,
      )
    : allLivePages;

  let exported = 0;
  let skipped = allLivePages.length - candidates.length;
  for (const p of candidates) {
    const result = exportPage(driver, dataDir, p.id);
    if (result.changed) exported++;
    else skipped++;
  }

  let deleted = 0;
  const stale = driver.all<{ path: string }>(
    `SELECT mf.path AS path
     FROM mirror_file mf
     LEFT JOIN page p ON p.id = mf.page_id
     WHERE p.id IS NULL OR p.deleted_at IS NOT NULL`,
  );
  for (const row of stale) {
    try {
      unlinkSync(join(dataDir, row.path));
    } catch {
      // Already gone on disk; still clean up the bookkeeping row below.
    }
    driver.run("DELETE FROM mirror_file WHERE path = ?", [row.path]);
    deleted++;
  }

  return { exported, skipped, deleted };
}

/**
 * Echo-suppression predicate (sql-schema.md rule 23): does `contentBuffer` match what we last
 * wrote to `filePath`? `filePath` must be in the same form stored in `mirror_file.path` (relative
 * to the mirror root, forward-slash separated, as produced by `pageFilePath`) — a future watcher
 * rooted at the data directory converts its absolute path via `path.relative` (and normalizes
 * backslashes on Windows) before calling this. Not wired into any live watcher here (see the
 * module header TODO); this is only the predicate such a watcher would call.
 */
export function isOwnWrite(driver: SqlDriver, filePath: string, contentBuffer: Buffer): boolean {
  const row = driver.get<{ content_hash: string }>(
    "SELECT content_hash FROM mirror_file WHERE path = ?",
    [filePath],
  );
  if (!row) return false;
  return row.content_hash === sha256Hex(contentBuffer);
}
