/**
 * The Hono app: `/` health check, `/openapi.json`, every op mounted at `/api/v1/<name>` (plus REST
 * aliases), `/mcp` (mount 3 of 3, `../mcp/server.ts`) sharing one bearer-auth check, and
 * `/sync/{push,pull,snapshot,live}` (`../sync/index.ts`, ADR 003) with its own auth gate.
 */

import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { bearerAuth } from "../auth/tokens.js";
import { mountUiLive } from "../live/index.js";
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
import { mountWebClient } from "./web-client.js";

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
  /**
   * Absolute path to a built web client (`apps/web/dist`). When set, the same origin also serves
   * the app itself — which is what lets one process be a desktop bundle or a phone-reachable home
   * server. Installed as the not-found handler, so it can never shadow an API/sync/MCP route
   * (`./web-client.ts`). Omitted, the server is API-only exactly as before.
   */
  webClientDir?: string;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = opts.app ?? new Hono();
  const { serverCtx, registry, config } = opts;

  // `/healthz` is the stable, machine-readable liveness probe. `/` answers the same JSON only
  // when no web client is being served — once there is one, `/` belongs to the app, and a JSON
  // health payload there would mean you could never open nooklet at its own root URL.
  const health = { name: "nooklet", status: "ok" } as const;
  app.get("/healthz", (c) => c.json(health));
  if (!opts.webClientDir) app.get("/", (c) => c.json(health));
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

  // `/ui/live` (ADR 015): a second, dedicated WebSocket, deliberately separate from `/sync/*`
  // above — see `../live/live.ts`'s header. Mounted here, before `mountMcp`, for the same reason
  // `mountSync` is: `mountMcp`'s sub-app matches `"/"` for every path, so a route registered after
  // it risks being shadowed.
  mountUiLive(app, serverCtx);

  mountMcp(app, registry, serverCtx, config, opts.version);

  // Last, and deliberately as `notFound` rather than a route: see `./web-client.ts`.
  if (opts.webClientDir) mountWebClient(app, { dir: opts.webClientDir });

  return app;
}
