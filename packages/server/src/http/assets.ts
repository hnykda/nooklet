/**
 * `GET /assets/:id` — serves an uploaded asset's raw bytes with its recorded mime type
 * (`asset.upload`, `../ops/asset-upload.ts`; ADR 013). Kept in its own module so mounting it in
 * `./app.ts` is a single `mountAssetRoutes(...)` call — that file is being edited concurrently for
 * `/sync/*` routes, so this keeps the diff there to one clearly separated line.
 *
 * Unauthenticated by design, like `/` and `/openapi.json`: nooklet binds to 127.0.0.1 only
 * (docs/spec/mcp-tools.md §3.9), and an `<img src="assets/<id>.<ext>">` tag in the rendered
 * Markdown has no way to attach a bearer token anyway. `id` is matched against the `asset` table
 * before any filesystem access, so this never serves an arbitrary path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import type { ServerConfig } from "../ops/registry.js";

interface AssetRow {
  ext: string;
  mime_type: string;
  deleted_at: number | null;
}

export function mountAssetRoutes(app: Hono, serverCtx: ServerContext, config: ServerConfig): void {
  app.get("/assets/:id", (c) => {
    const id = c.req.param("id").replace(/\.[a-zA-Z0-9]+$/, ""); // tolerate ".../:id.ext" too
    const row = serverCtx.driver.get<AssetRow>(
      "SELECT ext, mime_type, deleted_at FROM asset WHERE id = ?",
      [id],
    );
    if (!row || row.deleted_at !== null) {
      return c.json({ error: { code: "not_found", message: `no asset with id ${id}` } }, 404);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(config.dataDir, "assets", `${id}.${row.ext}`));
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
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": row.mime_type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}
