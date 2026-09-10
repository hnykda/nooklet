/**
 * The Hono app: `/` health check, `/openapi.json`, every op mounted at `/api/v1/<name>` (plus REST
 * aliases), and `/mcp` (mount 3 of 3, `../mcp/server.ts`) — all sharing one bearer-auth check.
 */

import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { bearerAuth } from "../auth/tokens.js";
import { mountMcp } from "../mcp/server.js";
import { buildOpContext, buildOpenApi, mountHttp, type OpRegistry, type ServerConfig } from "../ops/registry.js";

export interface CreateAppOptions {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  /** vrite package version, surfaced in the MCP server's `Implementation.version`. */
  version?: string;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();
  const { serverCtx, registry, config } = opts;

  app.get("/", (c) => c.json({ name: "vrite", status: "ok" }));
  app.get("/openapi.json", (c) => c.json(buildOpenApi(registry)));

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

  mountMcp(app, registry, serverCtx, config, opts.version);

  return app;
}
