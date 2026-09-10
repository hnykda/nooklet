/**
 * The two plugin-related HTTP surfaces that aren't per-plugin `registerRoute` calls: a static file
 * route serving a plugin's bundled client entry, and a listing endpoint so `apps/web` knows which
 * plugins to `import()` on startup. Split into `mountPluginClientRoute` (unauthenticated, mounted
 * before the `/api/v1/*` bearer-auth gate — same reasoning as `../http/assets.ts`: a `<script
 * src>` tag can't carry a bearer token) and `mountPluginListRoute` (authenticated, mounted after
 * it, alongside the op registry's own `mountHttp`) so `../http/app.ts`'s two call sites stay next
 * to their respective existing counterparts.
 */
import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import type { PluginHost } from "./host.js";

export function mountPluginClientRoute(app: Hono, host: PluginHost): void {
  app.get("/plugins/:id/:file", (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    const bundle = host.getClientBundle(id);
    if (!bundle || file !== `client.${bundle.hash}.js`) return c.notFound();
    let bytes: Buffer;
    try {
      bytes = readFileSync(bundle.file);
    } catch {
      return c.notFound(); // bundled once, then the temp file vanished — treat as not found
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        // Content-hashed URL (rule: the hash IS the cache key), safe to cache forever.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}

export function mountPluginListRoute(app: Hono, host: PluginHost): void {
  app.get("/api/v1/plugins", (c) =>
    c.json({
      plugins: host
        .list()
        .filter((p) => p.status === "active")
        .map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          has_client: p.hasClient,
          has_server: p.hasServer,
          client_url: p.clientUrl ?? null,
        })),
    }),
  );
}
