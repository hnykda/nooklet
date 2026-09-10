/**
 * `asset.upload` (ADR 013): writes an uploaded file's bytes under
 * `<config.dataDir>/assets/<id>.<ext>`, records it in the `asset` table (`docs/spec/sql-schema.md`
 * DDL), and returns a ready-to-paste Markdown image/link an agent can embed with the very next
 * `block_update`/`page_append` call.
 *
 * Assets are content-addressed: the `asset_sha256` unique index (schema.ts) is the source of
 * truth for dedup, so a second upload of identical bytes (even under a different filename) returns
 * the existing row instead of writing a duplicate file or a duplicate `changes` row.
 *
 * Assets are explicitly NOT in the op log (ADR 003 — binary blobs are not diffable text, and
 * `serverApplyOps`'s per-field LWW model has no field to route them through), so this handler
 * writes `asset`/`changes` directly via `ctx.db`, never `ctx.applyOps`. Per sql-schema.md rule 21,
 * the resulting `changes` row is the one documented case with `op_ids_json = '[]'` — still one row
 * per upload, still carrying `batch_id`/`origin`/`actor`/`after_json`, so `changes_since` and the
 * UI's attribution story cover assets too, just without an `op` to point at.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@nooklet/core";
import { z } from "zod";
import { defineOp, OpError } from "./registry.js";

/** 25 MB decoded, per the task's size cap recommendation. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Maps a handful of common types to a sane extension when `filename` has none usable. Falls back
 *  to `bin` — the file is still stored and served correctly via its recorded `mime_type`, an
 *  extension is only a filesystem/URL nicety. */
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

function extFromFilenameOrMime(filename: string, mimeType: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  if (m) return (m[1] as string).toLowerCase();
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

interface ExistingAssetRow {
  id: string;
  ext: string;
  mime_type: string;
  byte_size: number;
}

export const assetUpload = defineOp({
  name: "asset.upload",
  summary: "Upload a file (image, PDF, etc.) as a graph asset",
  description:
    "Uploads file bytes (base64-encoded) and returns an id plus a ready-to-paste markdown field " +
    "(e.g. ![alt](assets/1k7f3q9xz2hav4.png)) you can drop straight into the content of the very " +
    "next block_update/page_append/block_insert call to embed it. Assets are content-addressed by " +
    "SHA-256: uploading the exact same bytes again, even under a different filename, returns the " +
    "existing asset (deduped: true) instead of creating a duplicate. 25 MB decoded size limit. " +
    "Assets are not part of the op log (ADR 003) so batch_undo cannot reverse an upload, but the " +
    "upload is still recorded in the audit trail visible via changes_since. Fetch the raw bytes " +
    "later with GET <url>.",
  input: z
    .object({
      filename: z
        .string()
        .min(1)
        .max(255)
        .describe(
          "Original filename; used only to guess the file extension when mime_type doesn't map to one",
        ),
      mime_type: z.string().min(1).max(255).describe("IANA media type, e.g. image/png"),
      data_base64: z
        .string()
        .min(1)
        .describe("File bytes, standard base64 (padding optional). 25 MB decoded size limit."),
      alt: z
        .string()
        .max(1000)
        .optional()
        .describe("Alt text for the returned markdown image link"),
    })
    .strict(),
  output: z.object({
    id: z.string().describe("14-char asset id"),
    url: z.string().describe("Server path to fetch the raw bytes, e.g. /assets/1k7f3q9xz2hav4.png"),
    markdown: z
      .string()
      .describe(
        "Ready-to-paste markdown image/link, e.g. ![alt](assets/1k7f3q9xz2hav4.png) - paste this " +
          "directly into a block_update/page_append/block_insert content field",
      ),
    mime_type: z.string(),
    byte_size: z.number().int(),
    deduped: z
      .boolean()
      .describe(
        "true when identical bytes were already uploaded; this returned that existing asset",
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => out.markdown,
  handler: (input, ctx) => {
    if (!BASE64_RE.test(input.data_base64) || input.data_base64.length % 4 !== 0) {
      throw new OpError("invalid", "data_base64 is not valid base64");
    }
    const bytes = Buffer.from(input.data_base64, "base64");
    if (bytes.length === 0) {
      throw new OpError("invalid", "data_base64 decoded to zero bytes");
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      throw new OpError(
        "too_large",
        `asset is ${bytes.length} bytes, over the ${MAX_ASSET_BYTES}-byte limit`,
        "compress or resize the file before uploading",
      );
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = ctx.db.get<ExistingAssetRow>(
      "SELECT id, ext, mime_type, byte_size FROM asset WHERE sha256 = ? AND deleted_at IS NULL",
      [sha256],
    );
    if (existing) {
      return {
        id: existing.id,
        url: `/assets/${existing.id}.${existing.ext}`,
        markdown: `![${input.alt ?? ""}](assets/${existing.id}.${existing.ext})`,
        mime_type: existing.mime_type,
        byte_size: existing.byte_size,
        deduped: true,
      };
    }

    const id = newId();
    const ext = extFromFilenameOrMime(input.filename, input.mime_type);
    const dir = join(ctx.config.dataDir, "assets");
    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, `${id}.${ext}`);
    const tmpPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);

    const now = Date.now();
    ctx.db.run(
      `INSERT INTO asset(id, graph_id, file_name, ext, mime_type, byte_size, sha256, created_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`,
      [id, input.filename, ext, input.mime_type, bytes.length, sha256, now],
    );

    // Not in the op log (ADR 003) -> op_ids_json is '[]' (sql-schema.md rule 21's one documented
    // exception), but still one fully-audited `changes` row under its own fresh batch_id.
    const batchId = newId();
    ctx.db.run(
      `INSERT INTO changes(graph_id, batch_id, origin, actor, entity_type, entity_id, op_ids_json, before_json, after_json, created_at)
       VALUES ('default', ?, ?, ?, 'asset', ?, '[]', NULL, ?, ?)`,
      [
        batchId,
        ctx.origin.kind,
        ctx.actor.label,
        id,
        JSON.stringify({
          file_name: input.filename,
          ext,
          mime_type: input.mime_type,
          byte_size: bytes.length,
          sha256,
        }),
        now,
      ],
    );

    return {
      id,
      url: `/assets/${id}.${ext}`,
      markdown: `![${input.alt ?? ""}](assets/${id}.${ext})`,
      mime_type: input.mime_type,
      byte_size: bytes.length,
      deduped: false,
    };
  },
});
