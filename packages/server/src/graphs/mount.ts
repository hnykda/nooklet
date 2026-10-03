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
import { requireRootToken } from "../auth/root-token.js";
import { createToken } from "../auth/tokens.js";
import { serveStaticFile } from "../http/web-client.js";
import { graphDbPath } from "./paths.js";
import type { GraphRegistry } from "./registry.js";

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

export function createMultiGraphApp(opts: CreateMultiGraphAppOptions): Hono {
  const app = new Hono();
  const { registry, rootToken, dataDir, webClientDir } = opts;

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
    if (!existsSync(graphDbPath(dataDir, "default"))) {
      return c.json({ name: "nooklet", graphs: "/graphs" }, 404);
    }
    const url = new URL(c.req.url);
    return c.redirect(`/g/default${url.pathname}${url.search}`, 307);
  });

  return app;
}
