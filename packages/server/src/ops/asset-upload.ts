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

import { z } from "zod";
import { assetUrlPath } from "../assets/keys.js";
import { assetInfo, assetMarkdownPath, MAX_ASSET_BYTES, storeAssetBytes } from "../assets/store.js";
import { defineOp, OpError } from "./registry.js";

/** 25 MB decoded, per the task's size cap recommendation. */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** `type/subtype` in RFC 6838's token characters, no parameters. The value is echoed back as the
 * `Content-Type` of every later `GET /assets/:id`, so it must be a well-formed header value: a
 * newline in it made `new Response` throw, which surfaced as a 500 on every fetch of that asset. */
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Maps a handful of common types to a sane extension when `filename` has none usable. Falls back
 *  to `bin` — the file is still stored and served correctly via its recorded `mime_type`, an
 *  extension is only a filesystem/URL nicety. */
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
    "later with GET <url> (graph-relative; it carries the asset's secret key, so it needs no " +
    "token — share it only where the file may go). The markdown keeps the plain " +
    "assets/<id>.<ext> path; asset_info turns such a path's id back into a fetchable url.",
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
    url: z
      .string()
      .describe(
        "Graph-relative URL that fetches the raw bytes without a token, e.g. " +
          "/assets/1k7f3q9xz2hav4.png?k=<key>. The k parameter is the asset's secret key " +
          "(B-737): without it, or with a wrong one, the server answers 404",
      ),
    key: z.string().describe("The asset's secret URL key (the k in url)"),
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
    width: z.number().int().nullable().describe("Pixel width for a PNG/JPEG/GIF/WebP, else null"),
    height: z.number().int().nullable().describe("Pixel height for a PNG/JPEG/GIF/WebP, else null"),
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
    if (!MIME_TYPE_RE.test(input.mime_type)) {
      throw new OpError(
        "invalid",
        `mime_type "${input.mime_type}" is not a type/subtype media type`,
        "e.g. image/png or application/pdf, without parameters",
      );
    }
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

    const stored = storeAssetBytes(ctx.db, ctx.config.dataDir, {
      bytes,
      fileName: input.filename,
      mimeType: input.mime_type,
      origin: ctx.origin.kind,
      actor: ctx.actor.label,
    });
    return {
      id: stored.id,
      url: assetUrlPath(stored),
      key: stored.key,
      markdown: `![${input.alt ?? ""}](${assetMarkdownPath(stored)})`,
      mime_type: stored.mimeType,
      byte_size: stored.byteSize,
      deduped: stored.deduped,
      width: stored.width,
      height: stored.height,
    };
  },
});

/** Ids per `asset.info` call: a page of images, with room to spare. */
const MAX_INFO_IDS = 500;

/**
 * `asset.info` (B-737, ADR 036; was B-703's `asset.sizes`): what it takes to SHOW assets whose ids
 * a block names (`assets/<id>.<ext>`) — the URL with its secret key, and a picture's pixel size so
 * the client can give it its box before the lazily loaded bytes arrive.
 *
 * One op for both because the client needs both for the same images at the same moment: the web
 * client asks once per tick for every picture on screen and keeps the answers
 * (`apps/web/src/data/asset-info.ts`). Read scope: a token that can read the blocks can already
 * see every asset path in them, so the key tells it nothing it could not get from `asset.upload`'s
 * dedup or the UI. Exposed to MCP: an agent reading a block's `assets/<id>.png` has no other way
 * to a URL it can fetch.
 *
 * Fills in, from the file, the size of any asset stored before sizes were recorded
 * (`../assets/store.ts#assetInfo` says why on read rather than in a migration).
 */
export const assetInfoOp = defineOp({
  name: "asset.info",
  summary: "Fetchable URLs (and pixel sizes) of assets",
  description:
    "For each asset id given (the <id> in a block's assets/<id>.<ext>), returns a graph-relative " +
    "url that fetches the file without a token (it carries the asset's secret key k; without it " +
    "the server answers 404), the key itself, and the pixel width and height for PNG, JPEG, GIF " +
    "and WebP (null for anything else). Unknown or deleted ids are left out.",
  input: z
    .object({
      ids: z
        .array(z.string().min(1).max(64))
        .max(MAX_INFO_IDS)
        .describe("Asset ids, as in assets/<id>.<ext>"),
    })
    .strict(),
  output: z.object({
    assets: z.array(
      z.object({
        id: z.string(),
        url: z.string().describe("e.g. /assets/1k7f3q9xz2hav4.png?k=<key>, graph-relative"),
        key: z.string().describe("The asset's secret URL key (the k in url)"),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    out.assets.length === 0
      ? "no such assets"
      : out.assets.map((a) => `${a.id}: ${a.url}`).join("\n"),
  handler: (input, ctx) => ({
    assets: assetInfo(ctx.db, ctx.config.dataDir, [...new Set(input.ids)]).map((a) => ({
      id: a.id,
      url: assetUrlPath(a),
      key: a.key,
      width: a.width,
      height: a.height,
    })),
  }),
});
