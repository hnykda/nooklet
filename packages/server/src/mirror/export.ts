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
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  journalDayToFileName,
  pageNameToFileName,
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

export interface ExportFailure {
  pageId: string;
  error: string;
}

export interface ExportAllResult {
  exported: number;
  skipped: number;
  deleted: number;
  /** Pages whose file could not be written this time; the rest of the sweep still ran. */
  failed: ExportFailure[];
}

export interface ExportAllOptions {
  /**
   * Only consider pages that a `changes` row with `seq > sinceSeq` touched (`pagesTouchedSince`),
   * instead of rendering every live page. Deleted pages are pruned either way.
   *
   * This replaced an `onlyChanged` flag that picked pages whose `page.updated_at` or newest
   * `block.updated_at` was later than `mirror_file.written_at` (B-260). Only `block.text` moves
   * `updated_at`: a rename, a property, a marker, an indent or a move between pages reached the
   * database and never the file. `changes` has a row for every entity every commit touched,
   * whatever the op kind, and `seq` is a counter rather than a clock, so there is no
   * same-millisecond race either.
   */
  sinceSeq?: number;
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

/**
 * Longest file-name base, in UTF-8 bytes, that `pageFilePath` leaves alone. APFS and ext4 cap a
 * name at 255 bytes (NAME_MAX), NTFS at 255 UTF-16 units; a page name may be 512 characters, a
 * Czech letter is 2 bytes and an escaped character 3 (`%23`). Past the limit the rename failed
 * with ENAMETOOLONG on every mirror sweep (B-126). 200 leaves room for `.md` and the suffix.
 */
const MAX_FILE_BASE_BYTES = 200;

/** A page's file-name base, shortened past `MAX_FILE_BASE_BYTES` to a prefix plus
 * `~<8 hex of sha256(name)>`, so two long names sharing a prefix still get different files. The
 * mirror is one-way and `mirror_file` maps path to page, so nothing needs to decode it; the full
 * name travels inside the file as `title::` (see `exportPage`). */
function pageFileBase(name: string): { base: string; shortened: boolean } {
  const base = pageNameToFileName(name);
  if (Buffer.byteLength(base, "utf8") <= MAX_FILE_BASE_BYTES) return { base, shortened: false };
  const suffix = `~${sha256Hex(name).slice(0, 8)}`;
  let kept = "";
  let bytes = 0;
  // `for…of` walks code points, so a surrogate pair or a 2-byte letter is never split.
  for (const ch of base) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > MAX_FILE_BASE_BYTES - suffix.length) break;
    kept += ch;
    bytes += n;
  }
  // Nor is a `%XX` escape: a dangling `%` or `%2` would not decode back.
  kept = kept.replace(/%[0-9A-F]?$/, "");
  return { base: `${kept}${suffix}`, shortened: true };
}

/** Mirror-relative file path for a page (PLAN.md sec. 5). Forward-slash, relative to the data dir. */
export function pageFilePath(page: { name: string; journalDay: number | null }): string {
  if (page.journalDay !== null) return `journals/${journalDayToFileName(page.journalDay)}.md`;
  return `pages/${pageFileBase(page.name).base}.md`;
}

/**
 * Render + write one page's mirror file, skipping the write entirely when the rendered content
 * hash matches what `mirror_file` already recorded for this page (echo-suppression bookkeeping,
 * ADR 002) and the file is still on disk. Writes atomically (`<path>.tmp-<random>` then `fs.rename`). If the page's file path
 * changed since the last export (a rename), the old file and its stale `mirror_file` row are
 * removed.
 */
export function exportPage(driver: SqlDriver, dataDir: string, pageId: string): ExportResult {
  const rendered = renderPageToOutline(driver, pageId);
  const relPath = pageFilePath(rendered);
  // A shortened file name no longer says what the page is called. `title::` does, and it is what
  // the Logseq importer reads a page's name from, so the mirror stays lossless.
  if (
    rendered.journalDay === null &&
    rendered.parsed.properties.title === undefined &&
    pageFileBase(rendered.name).shortened
  ) {
    rendered.parsed.properties = { title: rendered.name, ...rendered.parsed.properties };
  }
  const text = serializeOutline(rendered.parsed);
  const contentHash = sha256Hex(text);

  const existing = driver.get<{ path: string; content_hash: string }>(
    "SELECT path, content_hash FROM mirror_file WHERE page_id = ?",
    [pageId],
  );

  const absPath = join(dataDir, relPath);
  // The row only says what we last wrote, not that it is still there (B-262): it travels with a
  // copied or restored `graph.sqlite` while `pages/` does not, and a file can be deleted by hand.
  // Trusting it alone made `nooklet export` of a copied database write 6 files out of 972.
  if (
    existing &&
    existing.path === relPath &&
    existing.content_hash === contentHash &&
    existsSync(absPath)
  ) {
    return { path: relPath, contentHash, changed: false };
  }

  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = join(dirname(absPath), `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, text, "utf8");
  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    // Without this, every live-mirror sweep that retried a failing page left another temp file.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing more to clean up.
    }
    throw err;
  }

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

/** The newest `changes.seq` — the cursor to pass as `sinceSeq` next time. */
export function changesHead(driver: SqlDriver): number {
  return driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0;
}

/**
 * Ids of the pages whose mirror file a commit after `sinceSeq` could have changed: a page row
 * that was written (create, rename, property, delete), and every page a written block was on
 * before or after the write. Both sides matter for a move — the page it left needs the block gone
 * from its file just as much as the page it joined needs it added. `changes` stores the block's
 * page in its snapshots (`rows.ts#snapshotBlock`), so this needs no reconstruction from ops.
 */
export function pagesTouchedSince(driver: SqlDriver, sinceSeq: number): string[] {
  return driver
    .all<{ page_id: string | null }>(
      `SELECT entity_id AS page_id FROM changes WHERE seq > ? AND entity_type = 'page'
       UNION
       SELECT json_extract(before_json, '$.place.pageId') FROM changes
         WHERE seq > ? AND entity_type = 'block' AND before_json IS NOT NULL
       UNION
       SELECT json_extract(after_json, '$.place.pageId') FROM changes
         WHERE seq > ? AND entity_type = 'block' AND after_json IS NOT NULL`,
      [sinceSeq, sinceSeq, sinceSeq],
    )
    .flatMap((r) => (r.page_id === null ? [] : [r.page_id]));
}

/**
 * Export every live page (or, with `sinceSeq`, every live page touched since then), then clean up
 * mirror files for pages that are no longer live: soft deleted (`page.deleted_at IS NOT NULL`,
 * `mirror_file` row still present) or hard-gone (the page id no longer exists in `page` at all).
 */
export function exportAll(
  driver: SqlDriver,
  dataDir: string,
  opts: ExportAllOptions = {},
): ExportAllResult {
  const allLivePages = driver.all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL");

  let candidates = allLivePages;
  if (opts.sinceSeq !== undefined) {
    const touched = new Set(pagesTouchedSince(driver, opts.sinceSeq));
    candidates = allLivePages.filter((p) => touched.has(p.id));
  }

  let exported = 0;
  let skipped = allLivePages.length - candidates.length;
  const failed: ExportFailure[] = [];
  for (const p of candidates) {
    // One page that cannot be written must not cost every page after it, or the prune below: a
    // throw here used to end the sweep, so deleted pages kept their files for as long as one bad
    // page existed (B-126). The failure is reported and retried on the next sweep.
    try {
      const result = exportPage(driver, dataDir, p.id);
      if (result.changed) exported++;
      else skipped++;
    } catch (err) {
      failed.push({ pageId: p.id, error: err instanceof Error ? err.message : String(err) });
    }
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

  return { exported, skipped, deleted, failed };
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
