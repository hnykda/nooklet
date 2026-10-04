/**
 * The Hono app: `/` health check, `/openapi.json`, every op mounted at `/api/v1/<name>` (plus REST
 * aliases), `/mcp` (mount 3 of 3, `../mcp/server.ts`) sharing one bearer-auth check, and
 * `/sync/{push,pull,snapshot,live}` (`../sync/index.ts`, ADR 003) with its own auth gate.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { createSoleToken } from "../auth/tokens.js";
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
import { suggestedTaskWorkflow } from "../task-workflow.js";
import { mountAssetRoutes } from "./assets.js";
import { installRequestGuards } from "./guards.js";
import { hostName, isLoopbackName } from "./host-names.js";
import { mountWebClient } from "./web-client.js";

export { isLoopbackName } from "./host-names.js";

export interface CreateAppOptions {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  /** nooklet package version, surfaced in the MCP server's `Implementation.version`. */
  version?: string;
  /**
   * M4/plugins: pass an already-constructed `Hono` app when a `PluginHost` (`../plugins/host.ts`)
   * has already mounted `ctx.registerRoute`/`rpc.expose` routes and the two plugin-discovery
   * routes (`../plugins/http.ts`) onto it, before this function's own routes. (`mountMcp` used to
   * merge a sub-app at `"/"` that could shadow later routes; since B-616 it is mounted at `/mcp`.)
   * Omitted, this creates a fresh app exactly as before M4 — every existing caller is unaffected.
   */
  app?: Hono;
  /**
   * M4/plugins: called (if given) right after `mountHttp` below — i.e. AFTER the `/api/v1/*`
   * bearer-auth gate exists, so a route mounted here (`../plugins/http.ts`'s
   * `mountPluginListRoute`, `GET /api/v1/plugins`) is authenticated by it — and BEFORE `mountSync`/
   * `mountMcp` (whose sub-app was a `"/"` catch-all before B-616). This is the one spot a route
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
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];

function isLoopbackRequest(c: Context): boolean {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    return false; // no socket (in-process `app.request()`); never hand out a credential
  }
  if (!remote) return false;
  // A reverse proxy on this same machine (`tailscale serve`, Caddy, nginx, a sidecar) makes EVERY
  // client's peer address 127.0.0.1 — so if it also rewrites `Host` to its upstream (a bare nginx
  // `proxy_pass http://127.0.0.1:6100;` does), every remote client passed both checks below and was
  // handed a write + sync token (`tools/probes/loopback-proxy-token.mjs`). A request that carries
  // forwarding headers came through a proxy on someone else's behalf, so it is never "this
  // machine". A proxy that rewrites Host AND adds no forwarding header is still indistinguishable
  // from a local browser — the deployment docs say not to configure one that way.
  for (const h of FORWARDING_HEADERS) if (c.req.header(h) !== undefined) return false;
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
 * The raw token is minted once per server process (see `webClientToken`) and held only in memory;
 * its hash is in the `token` table like any other, and the next process to mint one revokes it.
 */
function buildClientBootstrap(ctx: ServerContext, config: ServerConfig, c: Context): object {
  // The graph's identity goes to every client, credential or not: a client needs it to notice
  // that the replica it is holding belongs to a different graph than this server is serving
  // (`../graph-identity.ts`).
  const graphId = graphInstanceId(ctx.driver);
  // A suggestion, not a setting: the format this graph's journals were written in, used as the
  // client's initial choice and ignored the moment someone picks one (ADR 018).
  const journalTitleFormat = suggestedJournalTitleFormat(ctx.driver) ?? undefined;
  // B-608: the graph's task workflow, imported or inferred from its markers. Also a suggestion.
  const taskWorkflow = suggestedTaskWorkflow(ctx.driver);
  // `--no-loopback-token` (B-600, decision D3): behind a same-machine reverse proxy that rewrites
  // `Host` to its upstream and adds no forwarding header, every remote client is indistinguishable
  // from a local browser — the only safe answer there is to never auto-mint at all.
  if (!loopbackTokenEnabled(config))
    return {
      token: null,
      reason: "loopback_token_disabled",
      graphId,
      journalTitleFormat,
      taskWorkflow,
    };
  if (!isLoopbackRequest(c))
    return { token: null, reason: "non_loopback_host", graphId, journalTitleFormat, taskWorkflow };
  // A cross-origin caller never gets the auto-token, whatever its origin. The app shells allowed by
  // CORS (`graphs/mount.ts#APP_SHELL_ORIGINS`) run on phones, which are never loopback peers, so
  // they never need it; but `https://localhost` (Android's origin) can also be served by any local
  // dev server on this machine, and without this check such a page could read a write token
  // cross-origin. Same-origin fetches either omit `Origin` or name this server's own host.
  if (isCrossOriginRequest(c))
    return { token: null, reason: "cross_origin", graphId, journalTitleFormat, taskWorkflow };
  return { token: webClientToken(ctx), graphId, journalTitleFormat, taskWorkflow };
}

/** Whether the request names an `Origin` other than this server's own (by `Host`). Browsers send
 * `Origin` on every cross-origin fetch and cannot forge it; a same-origin page load sends none. */
function isCrossOriginRequest(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (c.req.header("host") ?? "");
  } catch {
    // `null` (opaque origins: sandboxed frames, file://) and anything unparsable: not ours.
    return true;
  }
}

/**
 * Whether the loopback auto-token is on. An explicit `--loopback-token` / `--no-loopback-token`
 * wins; otherwise it is on only for a loopback bind. A server bound to a LAN, tailnet or `0.0.0.0`
 * is one other machines reach, typically through a proxy, and every same-host proxy that rewrites
 * `Host` without a forwarding header makes remote clients look local (B-600). Fail closed there.
 * The desktop app's sidecar binds 127.0.0.1 (`apps/desktop/src-tauri/src/main.rs#spawn_server`
 * passes no `--host`), so it keeps its zero-config token.
 */
export function loopbackTokenEnabled(config: ServerConfig): boolean {
  return config.loopbackToken ?? isLoopbackName(config.host ?? "127.0.0.1");
}

/** Per-process web-client token, minted lazily on the first page load. `write` + `can_sync` is
 * what the app itself does; `ui_control` is deliberately NOT granted — that capability is for an
 * agent driving this window, and `/ui/live` only needs `can_sync` to expose one (ADR 015 §2.1).
 *
 * `createSoleToken`, not `createToken`: the previous process's token cannot be retired by the
 * process that minted it (it is gone), so it is retired here, by its successor. Without that,
 * every `nooklet serve` left one more live write credential in the table forever. */
export const WEB_CLIENT_TOKEN_LABEL = "web-client (auto)";
const webClientTokens = new WeakMap<ServerContext, string>();
function webClientToken(ctx: ServerContext): string {
  let token = webClientTokens.get(ctx);
  if (!token) {
    token = createSoleToken(ctx.driver, {
      label: WEB_CLIENT_TOKEN_LABEL,
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

  // Host allowlist, security headers, body limit and deny-by-default auth (`./guards.ts`).
  // Normally already installed by `createAppWithPlugins`, before any plugin route; a no-op then.
  installRequestGuards(app, serverCtx, config);

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
  app.get("/api/session", (c) => c.json(buildClientBootstrap(serverCtx, config, c)));
  if (!opts.webClientDir) app.get("/", (c) => c.json(health));
  app.get("/openapi.json", (c) => c.json(buildOpenApi(registry)));
  mountAssetRoutes(app, serverCtx, config); // GET /assets/:id (asset.upload, ADR 013)

  // `/api/v1/*` is authenticated by the guard above (`./guards.ts`), which also sets
  // `authScopes`/`authActorLabel`/`authTokenId` for `buildOpContext` here.

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
      bootstrap: (c) => buildClientBootstrap(serverCtx, config, c),
    });
  }

  return app;
}
