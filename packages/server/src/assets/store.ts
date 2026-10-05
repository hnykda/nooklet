/**
 * The one way an asset gets onto disk and into the `asset` table — shared by `asset.upload`
 * (bytes arriving over the API) and the Logseq importer (files already on disk in the source
 * graph's `assets/`). One writer, so both produce exactly the same thing: a content-addressed
 * file at `<dataDir>/assets/<id>.<ext>`, one `asset` row, one audited `changes` row.
 *
 * Content-addressed via the `asset_sha256` unique index (schema.ts): the same bytes stored twice
 * come back as the first copy, whichever path they arrived by. An import re-run after a partial
 * failure therefore does not duplicate anything.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { newId, type SqlDriver } from "@nooklet/core";
import { type ImageSize, imageSize } from "./image-size.js";
import { newAssetKey } from "./keys.js";

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "application/zip": "zip",
};

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);
// `jpg` maps to image/jpeg above by virtue of ordering; make the rest of the aliases explicit.
MIME_BY_EXT.jpeg = "image/jpeg";
MIME_BY_EXT.jpg = "image/jpeg";
MIME_BY_EXT.mp3 = "audio/mpeg";

/** The extension a stored file gets: the filename's own when it has a sane one, else the mime
 * type's, else `bin`. Lower-cased so `Photo.JPG` and `photo.jpg` are the same kind of thing. */
export function extFromFilenameOrMime(filename: string, mimeType: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  if (m?.[1]) return m[1].toLowerCase();
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

/** Best-effort mime type for a file we only have a name for (the importer's case). */
export function mimeFromFilename(filename: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  const ext = m?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

export interface StoreAssetInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  /** Who is doing this, for the `changes` row. */
  origin: string;
  actor: string;
  /** Size cap. Defaults to `MAX_ASSET_BYTES`, the API's limit; the importer, copying a person's
   *  own files off their own disk, passes `Infinity` — a 75 MB PDF they already have is not a
   *  request to be rate-limited. */
  maxBytes?: number;
}

export interface StoredAsset {
  id: string;
  ext: string;
  mimeType: string;
  byteSize: number;
  /** True when identical bytes were already stored and that record was returned instead. */
  deduped: boolean;
  /** The secret the asset's URL carries (`./keys.ts`, B-737). */
  key: string;
  /** Pixel size as displayed, for PNG/JPEG/GIF/WebP (`./image-size.ts`, B-703); else `null`. */
  width: number | null;
  height: number | null;
}

interface ExistingAssetRow {
  file_name: string;
  id: string;
  ext: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  url_key: string;
}

/** Write `bytes` as a new asset (or find the identical one already stored). Throws on an empty
 * or oversized payload; the caller decides how to report that. */
export function storeAssetBytes(
  driver: SqlDriver,
  dataDir: string,
  input: StoreAssetInput,
): StoredAsset {
  const { bytes } = input;
  const maxBytes = input.maxBytes ?? MAX_ASSET_BYTES;
  if (bytes.length === 0) throw new Error("asset is empty");
  if (bytes.length > maxBytes) {
    throw new Error(`asset is ${bytes.length} bytes, over the ${maxBytes}-byte limit`);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const size = imageSize(bytes);
  const existing = driver.get<ExistingAssetRow>(
    "SELECT id, ext, mime_type, byte_size, file_name, width, height, url_key FROM asset WHERE sha256 = ? AND deleted_at IS NULL",
    [sha256],
  );
  if (existing) {
    // Not a new write, but still an event worth a row (B-91): asset GC counts a recent `changes`
    // row as "touched", and the block op that embeds this asset again may sit in an offline
    // device's push queue for days. Without the row, a gc run inside that window would collect
    // the file of an asset that is about to be referenced again. before = after: nothing changed.
    const described = JSON.stringify({
      file_name: existing.file_name,
      ext: existing.ext,
      mime_type: existing.mime_type,
      byte_size: existing.byte_size,
      sha256,
    });
    driver.run(
      `INSERT INTO changes(graph_id, batch_id, origin, actor, entity_type, entity_id, op_ids_json, before_json, after_json, created_at)
       VALUES ('default', ?, ?, ?, 'asset', ?, '[]', ?, ?, ?)`,
      [newId(), input.origin, input.actor, existing.id, described, described, Date.now()],
    );
    return {
      id: existing.id,
      ext: existing.ext,
      mimeType: existing.mime_type,
      byteSize: existing.byte_size,
      deduped: true,
      key: existing.url_key,
      ...backfillFromBytes(driver, existing, size),
    };
  }

  const id = newId();
  const ext = extFromFilenameOrMime(input.fileName, input.mimeType);
  const dir = join(dataDir, "assets");
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${id}.${ext}`);
  // Write-then-rename, so a crash mid-write leaves a stray temp file rather than a half asset
  // that the `asset` row claims is whole.
  const tmpPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, finalPath);

  const now = Date.now();
  const key = newAssetKey();
  driver.run(
    `INSERT INTO asset(id, graph_id, file_name, ext, mime_type, byte_size, sha256, width, height, created_at, url_key)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.fileName,
      ext,
      input.mimeType,
      bytes.length,
      sha256,
      size?.width ?? null,
      size?.height ?? null,
      now,
      key,
    ],
  );

  // Not in the op log (ADR 003) -> op_ids_json is '[]' (sql-schema.md rule 21's one documented
  // exception), but still one fully-audited `changes` row under its own fresh batch_id.
  driver.run(
    `INSERT INTO changes(graph_id, batch_id, origin, actor, entity_type, entity_id, op_ids_json, before_json, after_json, created_at)
     VALUES ('default', ?, ?, ?, 'asset', ?, '[]', NULL, ?, ?)`,
    [
      newId(),
      input.origin,
      input.actor,
      id,
      JSON.stringify({
        file_name: input.fileName,
        ext,
        mime_type: input.mimeType,
        byte_size: bytes.length,
        sha256,
      }),
      now,
    ],
  );

  return {
    id,
    ext,
    mimeType: input.mimeType,
    byteSize: bytes.length,
    deduped: false,
    key,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/** An identical upload of an asset stored before sizes were recorded fills its size in. */
function backfillFromBytes(
  driver: SqlDriver,
  row: ExistingAssetRow,
  size: ImageSize | null,
): { width: number | null; height: number | null } {
  if (row.width !== null && row.height !== null) return { width: row.width, height: row.height };
  if (!size) return { width: null, height: null };
  driver.run("UPDATE asset SET width = ?, height = ? WHERE id = ?", [
    size.width,
    size.height,
    row.id,
  ]);
  return size;
}

/** Formats `imageSize` reads; anything else is not worth opening the file for. */
const SIZED_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Header reads tried in turn. A JPEG's size sits after its EXIF/ICC/XMP segments — usually inside
 * the first 64 KB, but a phone photo's embedded thumbnail and colour profile can push it further. */
const HEADER_READS = [64 * 1024, 1024 * 1024];

/** A stored file's displayed pixel size, reading as little of it as finds the size. */
export function readImageSizeFromFile(path: string, ext: string): ImageSize | null {
  if (!SIZED_EXTS.has(ext.toLowerCase())) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const total = fstatSync(fd).size;
    for (const want of [...HEADER_READS, total]) {
      const len = Math.min(want, total);
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, 0);
      const size = imageSize(buf.subarray(0, got));
      if (size || len >= total) return size;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface AssetInfoRow {
  id: string;
  ext: string;
  /** The secret its URL carries (`./keys.ts`, B-737). */
  key: string;
  width: number | null;
  height: number | null;
}

/**
 * What a client needs to show assets `ids` (`asset.info`): each one's URL key and, for a picture,
 * its pixel size. Unknown or deleted ids are left out.
 *
 * Fills in the size of any picture stored before sizes were recorded (B-703) from the file on
 * disk, here, on first read, rather than in a schema migration: a migration runs at startup,
 * before the server answers anything, and would open every asset file of every graph (thousands,
 * some on slow disks) to fill rows most of which nobody will look at soon. Here the cost is one
 * header read per asset, the first time a client shows it, and then never again. A file that has
 * no size we can read (an SVG, a PDF, a damaged image) stays `null` and is simply re-tried on its
 * next read; only image extensions are opened at all.
 */
export function assetInfo(
  driver: SqlDriver,
  dataDir: string,
  ids: readonly string[],
): AssetInfoRow[] {
  const out: AssetInfoRow[] = [];
  for (const id of ids) {
    const row = driver.get<Omit<AssetInfoRow, "key"> & { url_key: string }>(
      "SELECT id, ext, width, height, url_key FROM asset WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!row) continue;
    if (row.width === null || row.height === null) {
      const size = readImageSizeFromFile(join(dataDir, "assets", `${row.id}.${row.ext}`), row.ext);
      if (size) {
        driver.run("UPDATE asset SET width = ?, height = ? WHERE id = ?", [
          size.width,
          size.height,
          row.id,
        ]);
        row.width = size.width;
        row.height = size.height;
      }
    }
    out.push({ id: row.id, ext: row.ext, key: row.url_key, width: row.width, height: row.height });
  }
  return out;
}

/** The markdown-relative reference for a stored asset — what goes into block content. Always
 * `assets/<id>.<ext>`; the client turns it into an absolute URL at render time (B-51). */
export function assetMarkdownPath(a: { id: string; ext: string }): string {
  return `assets/${a.id}.${a.ext}`;
}
