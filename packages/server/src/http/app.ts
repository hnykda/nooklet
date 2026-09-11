/**
 * The Hono app: `/` health check, `/openapi.json`, every op mounted at `/api/v1/<name>` (plus REST
 * aliases), `/mcp` (mount 3 of 3, `../mcp/server.ts`) sharing one bearer-auth check, and
 * `/sync/{push,pull,snapshot,live}` (`../sync/index.ts`, ADR 003) with its own auth gate.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { bearerAuth, createToken } from "../auth/tokens.js";
import { graphInstanceId } from "../graph-identity.js";
import { suggestedJournalTitleFormat } from "../journal-format.js";
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

/** The `Host` header's hostname, without port; IPv6 literals arrive bracketed. */
function hostName(host: string | undefined): string {
  if (!host) return "";
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

function isLoopbackName(name: string): boolean {
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

/**
 * "Did this request come from this machine?" — decided by the PEER ADDRESS, not the `Host` header.
 *
 * `Host` is attacker-controlled. Trusting it meant anyone who could reach the server over a LAN
 * could mint themselves a `write` + `can_sync` token simply by asking for one:
 *
 *     curl -H 'Host: localhost:6100' http://192.168.1.6:6100/api/session
 *     -> {"token":"nk_…"}
 *
 * The socket's remote address cannot be forged that way. The `Host` check is kept as a second
 * condition rather than replaced: a DNS-rebinding attack arrives from a real loopback peer (the
 * victim's own browser) but carries the attacker's hostname, so both have to hold.
 */
function isLoopbackRequest(c: Context): boolean {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    return false; // no socket (in-process `app.request()`); never hand out a credential
  }
  if (!remote) return false;
  // Node reports IPv4-mapped IPv6 for a dual-stack listener.
  const peer = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
  const peerIsLoopback = peer === "::1" || peer.startsWith("127.");
  return peerIsLoopback && isLoopbackName(hostName(c.req.header("host")));
}

/**
 * What the served client is told about itself, injected as `window.__NOOKLET__`.
 *
 * The client needs a bearer token to reach its own API — search, backlinks, `/sync/*` and
 * `/ui/live` are all authenticated, and before this it had none, so a production build could
 * render but never load references, never search, and never sync.
 *
 * **A token is issued only to a loopback caller.** On loopback, anything that can fetch this page
 * can already read `graph.sqlite` directly, so the token grants nothing new and zero-config is the
 * right trade. Over a LAN or tailnet it would hand a write credential to anyone who loads the
 * page, so there the client gets a bootstrap with no token and must be given one explicitly.
 *
 * The token is minted once per server process (see `webClientToken`) rather than persisted: it
 * lives only in memory and in the HTML it is injected into, so a restart invalidates old sessions.
 */
function buildClientBootstrap(ctx: ServerContext, c: Context): object {
  // The graph's identity goes to every client, credential or not: a client needs it to notice
  // that the replica it is holding belongs to a different graph than this server is serving
  // (`../graph-identity.ts`).
  const graphId = graphInstanceId(ctx.driver);
  // A suggestion, not a setting: the format this graph's journals were written in, used as the
  // client's initial choice and ignored the moment someone picks one (ADR 018).
  const journalTitleFormat = suggestedJournalTitleFormat(ctx.driver) ?? undefined;
  if (!isLoopbackRequest(c))
    return { token: null, reason: "non_loopback_host", graphId, journalTitleFormat };
  return { token: webClientToken(ctx), graphId, journalTitleFormat };
}

/** Per-process web-client token, minted lazily on the first page load. `write` + `can_sync` is
 * what the app itself does; `ui_control` is deliberately NOT granted — that capability is for an
 * agent driving this window, and `/ui/live` only needs `can_sync` to expose one (ADR 015 §2.1). */
const webClientTokens = new WeakMap<ServerContext, string>();
function webClientToken(ctx: ServerContext): string {
  let token = webClientTokens.get(ctx);
  if (!token) {
    token = createToken(ctx.driver, {
      label: "web-client (auto)",
      scope: "write",
      canSync: true,
    }).token;
    webClientTokens.set(ctx, token);
  }
  return token;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = opts.app ?? new Hono();
  const { serverCtx, registry, config } = opts;

  /**
   * DNS-rebinding / unexpected-Host guard, registered BEFORE every route so that it actually
   * covers them.
   *
   * `@modelcontextprotocol/hono` ships its own equivalent, but `mountMcp` merges that sub-app at
   * the END of this function — and Hono composes handlers in registration order, so a terminal
   * handler registered earlier short-circuits before the merged middleware ever runs. It was
   * therefore guarding only the paths that had no earlier route, while `cli.ts` printed that
   * requests with an unexpected `Host` "are refused". They were not.
   *
   * Only enforced when bound to a non-loopback address: on loopback the peer is already this
   * machine, and a stricter default would break `nooklet serve` for everyone.
   */
  const boundHost = config.host ?? "127.0.0.1";
  if (!isLoopbackName(boundHost)) {
    const allowed = new Set([
      "127.0.0.1",
      "localhost",
      "[::1]",
      "::1",
      ...(config.allowedHosts ?? []),
    ]);
    app.use("*", async (c, next) => {
      const name = hostName(c.req.header("host"));
      if (!allowed.has(name)) {
        return c.json(
          {
            error: {
              code: "forbidden",
              message: `Host "${name || "(missing)"}" is not allowed. Start the server with --allow-host ${name || "<hostname>"} to reach it by this name.`,
            },
          },
          403,
        );
      }
      return next();
    });
  }

  // `/healthz` is the stable, machine-readable liveness probe. `/` answers the same JSON only
  // when no web client is being served — once there is one, `/` belongs to the app, and a JSON
  // health payload there would mean you could never open nooklet at its own root URL.
  const health = { name: "nooklet", status: "ok" } as const;
  app.get("/healthz", (c) => c.json(health));

  /**
   * This client's credentials, fetched at runtime rather than read out of the HTML.
   *
   * The token used to be injected into `index.html` alone — which the PWA service worker
   * precaches AT BUILD TIME, so from the second load onward the browser was served a shell with
   * no token in it and the app silently lost its credentials on every reload. A shell is static
   * and cacheable; a credential is neither, so it gets its own endpoint. `/api/…` is already
   * `NetworkOnly` in the service worker's runtime caching (`apps/web/vite.config.ts`), and this
   * sits outside `/api/v1/*` so it is deliberately NOT behind `bearerAuth` — it is what you call
   * when you do not yet have a token.
   */
  app.get("/api/session", (c) => c.json(buildClientBootstrap(serverCtx, c)));
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
  if (opts.webClientDir) {
    mountWebClient(app, {
      dir: opts.webClientDir,
      bootstrap: (c) => buildClientBootstrap(serverCtx, c),
    });
  }

  return app;
}
