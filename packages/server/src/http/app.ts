/**
 * The Hono app: `/` health check, `/openapi.json`, every op mounted at `/api/v1/<name>` (plus REST
 * aliases), `/mcp` (mount 3 of 3, `../mcp/server.ts`) sharing one bearer-auth check, and
 * `/sync/{push,pull,snapshot,live}` (`../sync/index.ts`, ADR 003) with its own auth gate.
 */

import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { bearerAuth } from "../auth/tokens.js";
import { mountMcp } from "../mcp/server.js";
import {
  buildOpContext,
  buildOpenApi,
  mountHttp,
  type OpRegistry,
  type ServerConfig,
} from "../ops/registry.js";
import { mountSync } from "../sync/index.js";
import { mountAssetRoutes } from "./assets.js";

export interface CreateAppOptions {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  /** nooklet package version, surfaced in the MCP server's `Implementation.version`. */
  version?: string;
  /**
   * M4/plugins: pass an already-constructed `Hono` app when a `PluginHost` (`../plugins/host.ts`)
   * has already mounted `ctx.registerRoute`/`rpc.expose` routes and the two plugin-discovery
   * routes (`../plugins/http.ts`) onto it. MUST happen before this function's own `mountMcp` call
   * below — that mount merges in a sub-app at `"/"` that matches every path on this app, so
   * anything registered after it risks being shadowed (see that call's own comment). Omitted, this
   * creates a fresh app exactly as before M4 — every existing caller is unaffected.
   */
  app?: Hono;
  /**
   * M4/plugins: called (if given) right after `mountHttp` below — i.e. AFTER the `/api/v1/*`
   * bearer-auth gate exists, so a route mounted here (`../plugins/http.ts`'s
   * `mountPluginListRoute`, `GET /api/v1/plugins`) is authenticated by it — and BEFORE `mountSync`/
   * `mountMcp`, so it isn't shadowed by `mountMcp`'s `"/"` catch-all. This is the one spot a route
   * needing BOTH of those things can be added without `../plugins/` reaching back into this file.
   */
  mountBeforeMcp?: (app: Hono) => void;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = opts.app ?? new Hono();
  const { serverCtx, registry, config } = opts;

  app.get("/", (c) => c.json({ name: "nooklet", status: "ok" }));
  app.get("/openapi.json", (c) => c.json(buildOpenApi(registry)));
  mountAssetRoutes(app, serverCtx, config); // GET /assets/:id (asset.upload, ADR 013)

  app.use("/api/v1/*", bearerAuth(serverCtx.driver));

  mountHttp(app, registry, async (c) => {
    const scopes = c.get("authScopes");
    if (!scopes) return null; // bearerAuth middleware already answered 401 before this ever runs
    const actorLabel = c.get("authActorLabel");
    const tokenId = c.get("authTokenId");
    return buildOpContext(
      serverCtx,
      config,
      { scopes, actor: { label: actorLabel, tokenId }, origin: { kind: "api", tokenId } },
      {
        transport: "http",
        requestId: crypto.randomUUID(),
        idempotencyKey: c.req.header("idempotency-key") ?? undefined,
      },
    );
  });

  opts.mountBeforeMcp?.(app);

  // `/sync/push`, `/sync/pull`, `/sync/snapshot`, `/sync/live` (ADR 003): its own bearer-token
  // gate (`../sync/auth.ts`), not `bearerAuth` above, since sync additionally requires
  // `token.can_sync` and the WebSocket route authenticates from its first message, not a header.
  // Mounted BEFORE `mountMcp` below: `@modelcontextprotocol/hono`'s app is merged in at `"/"`
  // (`app.route("/", mcpApp)`, `../mcp/server.ts`), which installs request handling that runs for
  // every path on this app, not only `/mcp` — registering `/sync/*` first means Hono matches
  // these static routes before that catch-all ever runs.
  mountSync(app, serverCtx);

  mountMcp(app, registry, serverCtx, config, opts.version);

  return app;
}
