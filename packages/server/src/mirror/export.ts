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
 * blocks and properties in three queries, not one round trip per block.
 *
 * Reserved block columns (`scheduled_day`/`scheduled_time`, `deadline_day`/`deadline_time`,
 * `repeat`, `done_at` — sql-schema.md rule 10, ADR 011) were pulled OUT of ordinary `key:: value`
 * property lines and into dedicated columns by `applyOps`/`serverApplyOps` on write. The mirror
 * must reconstitute them as ordinary property lines to match the canonical grammar and
 * `outline.ts`'s importer (`parseOutline` has no notion of these columns — it only ever produces
 * a plain `properties` bag). `@nooklet/core`'s `formatDayTime`/`formatDoneIso` produce exactly the
 * strings the reducer's `SCHEDULED_RE`/`DONE_RE` accept on the way back in.
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
  formatDayTime,
  formatDoneIso,
  journalDayToFileName,
  type OutlineNode,
  type ParsedPage,
  type Priority,
  type Properties,
  pageNameToFileName,
  type SqlDriver,
  serializeOutline,
  type TaskMarker,
} from "@nooklet/core";

export interface RenderedPage {
  pageId: string;
  name: string;
  journalDay: number | null;
  parsed: ParsedPage;
}

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
   * When true, skip pages that could not possibly have changed since their last export (no
   * live block or the page row itself touched after `mirror_file.written_at`) without even
   * rendering them. Purely a perf fast path — `exportPage` already no-ops on an unchanged
   * render regardless of this flag, so results are identical either way, just cheaper to reach
   * on a large graph where most pages are untouched between calls.
   */
  onlyChanged?: boolean;
}

interface BlockRow {
  id: string;
  parent_id: string | null;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a page's row plus its full live block tree (excluding soft-deleted blocks and, per
 * "hiding a block hides its descendants for free", their entire subtree) directly via `driver`,
 * and build the `ParsedPage` tree `serializeOutline` expects. Throws if `pageId` does not name a
 * live (non-deleted) page — callers (`exportPage`/`exportAll`) only ever call this for pages
 * they've already confirmed are live.
 */
export function renderPageToOutline(driver: SqlDriver, pageId: string): RenderedPage {
  const page = driver.get<{ name: string; journal_day: number | null; deleted_at: number | null }>(
    "SELECT name, journal_day, deleted_at FROM page WHERE id = ?",
    [pageId],
  );
  if (!page || page.deleted_at !== null) {
    throw new Error(`renderPageToOutline: no live page with id ${pageId}`);
  }

  const pageProps = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM page_prop WHERE page_id = ? AND value IS NOT NULL ORDER BY key",
    [pageId],
  );
  const properties: Properties = {};
  for (const p of pageProps) if (p.value !== null) properties[p.key] = p.value;

  const blockRows = driver.all<BlockRow>(
    `SELECT id, parent_id, content, marker, priority, collapsed,
            scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at
     FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY order_key`,
    [pageId],
  );

  const propRows = driver.all<{ block_id: string; key: string; value: string | null }>(
    `SELECT bp.block_id AS block_id, bp.key AS key, bp.value AS value
     FROM block_prop bp
     JOIN block b ON b.id = bp.block_id
     WHERE b.page_id = ? AND b.deleted_at IS NULL AND bp.value IS NOT NULL
     ORDER BY bp.key`,
    [pageId],
  );
  const propsByBlock = new Map<string, Array<[string, string]>>();
  for (const row of propRows) {
    if (row.value === null) continue;
    const list = propsByBlock.get(row.block_id) ?? [];
    list.push([row.key, row.value]);
    propsByBlock.set(row.block_id, list);
  }

  // Group by parent while preserving each group's relative order_key order: filtering a
  // globally order_key-sorted array preserves the relative order within any subset.
  const childrenByParent = new Map<string | null, BlockRow[]>();
  for (const row of blockRows) {
    const list = childrenByParent.get(row.parent_id) ?? [];
    list.push(row);
    childrenByParent.set(row.parent_id, list);
  }

  const buildNode = (row: BlockRow): OutlineNode => {
    const nodeProps: Properties = {};
    for (const [k, v] of propsByBlock.get(row.id) ?? []) nodeProps[k] = v;
    if (row.scheduled_day !== null) {
      nodeProps.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
    }
    if (row.deadline_day !== null) {
      nodeProps.deadline = formatDayTime(row.deadline_day, row.deadline_time);
    }
    if (row.repeat !== null) nodeProps.repeat = row.repeat;
    if (row.done_at !== null) nodeProps.done = formatDoneIso(row.done_at);

    return {
      id: row.id,
      content: row.content,
      marker: row.marker,
      priority: row.priority,
      collapsed: row.collapsed !== 0,
      properties: nodeProps,
      children: (childrenByParent.get(row.id) ?? []).map(buildNode),
    };
  };

  const roots = (childrenByParent.get(null) ?? []).map(buildNode);

  return {
    pageId,
    name: page.name,
    journalDay: page.journal_day,
    parsed: { properties, blocks: roots },
  };
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
 * ADR 002). Writes atomically (`<path>.tmp-<random>` then `fs.rename`). If the page's file path
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

  if (existing && existing.path === relPath && existing.content_hash === contentHash) {
    return { path: relPath, contentHash, changed: false };
  }

  const absPath = join(dataDir, relPath);
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
