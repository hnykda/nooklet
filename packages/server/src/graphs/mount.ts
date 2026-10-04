/**
 * The top-level, multi-graph Hono app (ADR 025): `GET/POST /graphs` (root-token gated, span every
 * graph this server hosts) plus a dynamic `.mount("/g", ...)` dispatcher that resolves `/g/:graphId/
 * *` to the right graph's own, completely unmodified `createAppWithPlugins()` app and forwards the
 * request to it.
 *
 * Verified against Hono 4.13.7's own source before writing this (see the plan this implements):
 * `.mount()`'s default `replaceRequest` already does `new Request(url, request)` internally and
 * forwards `env`/`executionCtx` to the nested handler — which is also how `@hono/node-server`'s
 * WebSocket upgrade correlates a connection (via `env`, not via which Hono app's routing table
 * matched). Dispatching to N independent per-graph apps this way needs no change to `mountHttp`/
 * `mountSync`/`mountUiLive`/`mountAssetRoutes`/`mountMcp` — this file is pure composition.
 */

import { existsSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireRootToken } from "../auth/root-token.js";
import { createToken } from "../auth/tokens.js";
import { limitBody, securityHeaders } from "../http/guards.js";
import { serveStaticFile } from "../http/web-client.js";
import { graphDbPath } from "./paths.js";
import type { GraphRegistry } from "./registry.js";
import { GraphRetireError } from "./retire.js";

/** `Hono#fetch`'s own env/executionCtx parameter types, taken from its type rather than
 * re-declared as `any` — they're opaque platform bindings whose exact shape only matters to
 * `@hono/node-server`'s own WebSocket wiring, which is exactly why threading them through
 * unmodified (not narrowing or re-typing them) is the point. */
type GraphAppFetchArgs = Parameters<Hono["fetch"]>;

function errorJson(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Strips the already-`.mount()`-resolved first path segment (the graph id) and hands the rest of
 * the request to that graph's app, exactly as `Hono#mount`'s own default `replaceRequest` strips
 * ITS prefix — same idiom, one segment further in. */
function graphDispatcher(registry: GraphRegistry) {
  return async (
    request: Request,
    env?: GraphAppFetchArgs[1],
    executionCtx?: GraphAppFetchArgs[2],
  ): Promise<Response> => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const graphId = segments[0];
    if (!graphId) {
      return Response.json(errorJson("not_found", "No graph id in the URL"), { status: 404 });
    }
    const handle = await registry.resolve(graphId);
    if (!handle) {
      return Response.json(errorJson("not_found", `No graph "${graphId}" on this server`), {
        status: 404,
      });
    }
    url.pathname = `/${segments.slice(1).join("/")}`;
    const innerRequest = new Request(url, request);
    return handle.app.fetch(innerRequest, env, executionCtx);
  };
}

export interface CreateMultiGraphAppOptions {
  dataDir: string;
  registry: GraphRegistry;
  rootToken: string;
  /** Forwarded to each graph's own `createApp`, and — the one place this app needs it directly —
   * a few PWA-critical files served unredirected at bare origin, see the route below. */
  webClientDir?: string;
}

/**
 * Origins of nooklet's own bundled app shells, which load the client from a custom scheme and so
 * reach every server cross-origin: the iOS Capacitor shell (`capacitor://localhost`) and, since
 * the Android project exists (2026-10-04, experimental), Android's (`https://localhost`).
 * `apps/web/capacitor.config.ts` keeps Capacitor's default `iosScheme`/`androidScheme`/`hostname`
 * and pins them, because the origin is also the OPFS storage key.
 *
 * Unlike `capacitor://`, an `https://localhost` page can also be served by something else on the
 * server's own machine (a local dev server with a trusted certificate). It still cannot read the
 * loopback auto-token: `/api/session` refuses the token to any cross-origin caller
 * (`http/app.ts#isCrossOriginRequest`, B-691), and app shells never need it (phones are never
 * loopback peers). What such a page can do is what any page with a token could. Capacitor
 * cannot give Android a hostname of its own without changing iOS's origin too (`server.hostname`
 * is shared), which would orphan every iOS install's data.
 *
 * Deliberately an exact allowlist, never `*`: `/api/session` hands a write token to any loopback
 * caller, and a wildcard would let any website open in a browser on the server's own machine read
 * that response. A web page cannot forge its `Origin`, so `capacitor://localhost` is reachable
 * only from an installed app shell. The web/PWA client and the desktop app are same-origin with
 * the server and never send a cross-origin request, so they are unaffected.
 */
export const APP_SHELL_ORIGINS: ReadonlySet<string> = new Set([
  "capacitor://localhost",
  "https://localhost",
]);

/**
 * Without this, the iOS app could not reach any server at all: every request it makes carries an
 * `Authorization` header (so WebKit preflights it), the preflight hit the per-graph bearer gate and
 * got a 401 with no `Access-Control-Allow-Origin`, and even the unpreflighted `GET /api/session`
 * was unreadable. WebKit reports all of that as an opaque "TypeError: Load failed"
 * (`tools/probes/capacitor-network/`, run on the iOS Simulator). Registered on THIS app, ahead of
 * the `/g` mount and the bare-origin redirect, so a preflight is answered here — never redirected
 * (a preflight that gets a 3xx fails outright) and never reaches a graph's own auth or Host guard.
 * The real request still goes through both.
 */
const appShellCors = cors({
  origin: (origin) => (APP_SHELL_ORIGINS.has(origin) ? origin : null),
  allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  allowHeaders: ["authorization", "content-type", "accept", "idempotency-key"],
  maxAge: 600,
});

export function createMultiGraphApp(opts: CreateMultiGraphAppOptions): Hono {
  const app = new Hono();
  const { registry, rootToken, dataDir, webClientDir } = opts;

  // nosniff / DENY / no-referrer (+ HSTS behind TLS) on everything this app answers itself; each
  // graph's own app sets the same (`../http/guards.ts`), and only absent headers are added.
  app.use("*", securityHeaders);

  app.use("*", (c, next) => {
    // Any other origin (or none — same-origin, curl, agents) passes through untouched, so this
    // changes nothing for any client except the app shells above. A WebSocket upgrade is not
    // subject to CORS at all, and its 101 response must not be rewritten.
    const origin = c.req.header("origin");
    if (!origin || !APP_SHELL_ORIGINS.has(origin) || c.req.header("upgrade")) return next();
    return appShellCors(c, next);
  });

  // A service worker registration is rejected outright if its script response is the result of a
  // redirect — so `/sw.js` and the handful of files it needs (its own workbox runtime chunk, the
  // web manifest) need one unredirected route here, even though every OTHER bare-origin path
  // deliberately redirects to a graph below. These are graph-agnostic build artifacts (the same
  // regardless of which graph is being viewed), so serving them straight from `webClientDir` is
  // correct, not just convenient. Matched BEFORE the redirect fallback, and only these exact known
  // names — this is not general static-file serving at bare origin.
  if (webClientDir) {
    app.get("/sw.js", async (c) => {
      const res = await serveStaticFile(webClientDir, "/sw.js");
      return res ?? c.notFound();
    });
    app.get("/manifest.webmanifest", async (c) => {
      const res = await serveStaticFile(webClientDir, "/manifest.webmanifest");
      return res ?? c.notFound();
    });
    app.get("/workbox-*", async (c) => {
      const res = await serveStaticFile(webClientDir, new URL(c.req.url).pathname);
      return res ?? c.notFound();
    });
  }

  // Process-level liveness, independent of any graph — "is nooklet up at all," answerable even
  // when this server hosts zero graphs (a brand-new data dir, mid-setup). Distinct from each
  // graph's own `/g/<id>/healthz` (mounted inside `createApp`), which additionally says whether
  // THAT graph's database opened cleanly. `e2e/global-setup.ts` and `apps/desktop/launcher/
  // index.html`'s `reachable()` probe both poll a bare `/healthz` before anything graph-specific
  // exists to ask.
  app.get("/healthz", (c) => c.json({ name: "nooklet", status: "ok" }));

  const graphs = new Hono();
  graphs.use("*", requireRootToken(rootToken));
  // Bounded before the root token is even checked would be nicer, but the gate reads no body.
  graphs.use("*", limitBody);
  graphs.get("/", async (c) => {
    const list = await registry.list();
    return c.json({ graphs: list });
  });
  graphs.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const id = typeof body.id === "string" ? body.id : undefined;
    const label = typeof body.label === "string" ? body.label : undefined;
    if (!id) return c.json(errorJson("invalid_request", '"id" is required'), 400);
    let handle: Awaited<ReturnType<GraphRegistry["create"]>>;
    try {
      handle = await registry.create(id, label);
    } catch (err) {
      return c.json(errorJson("invalid_request", (err as Error).message), 400);
    }
    // Minted immediately so the caller (the client's "promote" flow) can start pushing ops to the
    // graph it just created in one round trip, rather than a second request to `nooklet token`.
    const created = createToken(handle.ctx.driver, {
      label: "graph creator",
      scope: "admin",
      canSync: true,
    });
    return c.json(
      { id: handle.id, label: label ?? id, token: created.token, graphId: handle.config.graphId },
      201,
    );
  });
  // B-713: retire a graph while the server runs. The registry closes the graph's sockets (4410)
  // and database before its folder moves to `graphs-retired/`; nothing is deleted. Root token
  // only, like the rest of `/graphs`, and never an MCP tool: an agent holding a graph token must
  // not be able to make a graph disappear.
  graphs.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const force = c.req.query("force") === "true";
    try {
      const r = await registry.retire(id, { force });
      return c.json({
        id: r.id,
        retired: r.retiredName,
        path: `graphs-retired/${r.retiredName}`,
        restore: `nooklet graph unretire ${r.retiredName}`,
      });
    } catch (err) {
      if (err instanceof GraphRetireError) {
        const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
        return c.json(errorJson(err.code, err.message), status);
      }
      throw err;
    }
  });
  app.route("/graphs", graphs);

  app.mount("/g", graphDispatcher(registry));

  // Bare-origin fallback, matched only once nothing above did (`/healthz`, `/graphs`, `/g/*` are
  // all more specific and registered first): when this server hosts a "default" graph, redirect
  // ANY other path there rather than 404 on it. 307 (not 302), which preserves method and body —
  // this is what keeps a `POST /api/v1/page.create` at bare origin working, not just `GET /` —
  // and is exactly what lets a single-graph deployment (the common case — this comment is really
  // for whoever wonders why a request with no `/g/` in it ever works at all) stay as close to
  // zero-friction as it was before ADR 025: nothing above `/g/<id>/` needs to know its own slug.
  app.all("*", (c) => {
    // A WebSocket never follows a redirect, so a 307 here would only be a slower way to fail.
    // Say what is wrong instead (B-602): the client stored an address without `/g/<id>`.
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return c.json(
        errorJson(
          "not_found",
          "WebSocket endpoints live under /g/<graph-id>/ (e.g. /g/default/sync/live); a bare path is not redirected.",
        ),
        404,
      );
    }
    if (!existsSync(graphDbPath(dataDir, "default"))) {
      return c.json({ name: "nooklet", graphs: "/graphs" }, 404);
    }
    const url = new URL(c.req.url);
    return c.redirect(`/g/default${url.pathname}${url.search}`, 307);
  });

  return app;
}
