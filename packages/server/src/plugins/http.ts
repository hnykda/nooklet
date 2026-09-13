/**
 * The two plugin-related HTTP surfaces that aren't per-plugin `registerRoute` calls: a static file
 * route serving a plugin's bundled client entry, and a listing endpoint naming each active plugin
 * and its client bundle URL. (`apps/web` requests neither since ADR 023 — it compiles the built-in
 * client halves into its own build; these remain for a future runtime client host.) Split into `mountPluginClientRoute` (unauthenticated, mounted
 * before the `/api/v1/*` bearer-auth gate — same reasoning as `../http/assets.ts`: a `<script
 * src>` tag can't carry a bearer token) and `mountPluginListRoute` (authenticated, mounted after
 * it, alongside the op registry's own `mountHttp`) so `../http/app.ts`'s two call sites stay next
 * to their respective existing counterparts.
 */
import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import type { PluginHost } from "./host.js";

export function mountPluginClientRoute(app: Hono, host: PluginHost): void {
  app.get("/plugins/:id/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    let bundle: { file: string; hash: string } | undefined;
    try {
      bundle = await host.clientBundle(id);
    } catch {
      // Unauthenticated route: esbuild's message (absolute paths on this disk) goes to the server
      // log, where `clientBundle` already wrote it, not to whoever asked (B-186).
      return c.text(`plugin "${id}" client half failed to bundle; see the server log`, 500);
    }
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
  app.get("/api/v1/plugins", async (c) => {
    // Client halves are bundled on first request, not at startup (`PluginHost.clientBundle`).
    await host.ensureClientBundles();
    return c.json({
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
    });
  });
}
