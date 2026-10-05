/**
 * `GET /assets/:id` — serves an uploaded asset's raw bytes with its recorded mime type
 * (`asset.upload`, `../ops/asset-upload.ts`; ADR 013).
 *
 * Unauthenticated by design: an `<img src="assets/<id>.<ext>">` in rendered Markdown has no way to
 * attach a bearer token. `id` is matched against the `asset` table before any filesystem access,
 * so this never serves an arbitrary path. Ids are 14-char time-ordered strings with 25 random bits
 * (ADR 004) — not a secret, but not enumerable in practice either, which is the right trade for a
 * server that is loopback-only by default and behind a tailnet otherwise.
 *
 * Two headers make an upload harmless even when its bytes are hostile. `X-Content-Type-Options:
 * nosniff` stops a browser second-guessing the recorded type. `Content-Security-Policy: sandbox`
 * makes any DOCUMENT built from the response (someone opening an uploaded `.html` or a scripted
 * `.svg` in a tab) run in an opaque origin with no script, no forms, no access to the app's
 * origin — where it would otherwise read `localStorage`, the device token included. Neither header
 * affects the normal case: an `<img>`, `<video>` or `<audio>` subresource is not a document, and
 * CSP `sandbox` does not apply to it.
 *
 * `?w=<width>` asks for a resized picture (ADR 035, `../assets/variants.ts`): one of a fixed set of
 * widths, as WebP, made on first request and cached on disk. Under the same route and the same
 * (absence of) auth as the original on purpose: whatever B-737 settles for asset URLs then covers
 * both. When no variant can or need be made the original's bytes answer, so a `?w=` URL always
 * shows the picture. Same headers either way; a variant is as immutable as its original.
 */

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { parseVariantParam, variantFile } from "../assets/variants.js";
import type { ServerConfig } from "../ops/registry.js";

interface AssetRow {
  ext: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  deleted_at: number | null;
}

export function mountAssetRoutes(app: Hono, serverCtx: ServerContext, config: ServerConfig): void {
  app.get("/assets/:id", async (c) => {
    const id = c.req.param("id").replace(/\.[a-zA-Z0-9]+$/, ""); // tolerate ".../:id.ext" too
    const want = parseVariantParam(c.req.queries("w"));
    if (want.kind === "bad") {
      return c.json({ error: { code: "bad_request", message: want.message } }, 400);
    }
    const row = serverCtx.driver.get<AssetRow>(
      "SELECT ext, mime_type, byte_size, width, deleted_at FROM asset WHERE id = ?",
      [id],
    );
    if (!row || row.deleted_at !== null) {
      return c.json({ error: { code: "not_found", message: `no asset with id ${id}` } }, 404);
    }
    let path = join(config.dataDir, "assets", `${id}.${row.ext}`);
    let contentType = row.mime_type;
    if (want.kind === "variant" && existsSync(path)) {
      const variant = await variantFile(
        { dataDir: config.dataDir, id, ext: row.ext, naturalWidth: row.width },
        want.width,
      );
      if (variant) {
        path = variant;
        contentType = "image/webp";
      }
    }
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return c.json(
        {
          error: {
            code: "not_found",
            message: "asset is recorded but its file is missing on disk",
          },
        },
        404,
      );
    }
    // Streamed, not `readFileSync`: an asset can be 25 MB, and a synchronous read of that blocks
    // every other request on the server for its duration.
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        "content-type": contentType,
        "content-length": String(size),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });
}
