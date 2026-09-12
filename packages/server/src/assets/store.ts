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
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type SqlDriver } from "@nooklet/core";

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
}

interface ExistingAssetRow {
  file_name: string;
  id: string;
  ext: string;
  mime_type: string;
  byte_size: number;
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
  const existing = driver.get<ExistingAssetRow>(
    "SELECT id, ext, mime_type, byte_size, file_name FROM asset WHERE sha256 = ? AND deleted_at IS NULL",
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
  driver.run(
    `INSERT INTO asset(id, graph_id, file_name, ext, mime_type, byte_size, sha256, created_at)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
    [id, input.fileName, ext, input.mimeType, bytes.length, sha256, now],
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

  return { id, ext, mimeType: input.mimeType, byteSize: bytes.length, deduped: false };
}

/** The markdown-relative reference for a stored asset — what goes into block content. Always
 * `assets/<id>.<ext>`; the client turns it into an absolute URL at render time (B-51). */
export function assetMarkdownPath(a: { id: string; ext: string }): string {
  return `assets/${a.id}.${a.ext}`;
}
