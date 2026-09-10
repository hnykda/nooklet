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
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();
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
