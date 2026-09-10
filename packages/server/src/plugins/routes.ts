/**
 * `ServerPluginContext.registerRoute`: mounts a plugin's Hono sub-app, or a single
 * `(method, path, handler)` route, under `/api/plugins/<id>/`.
 *
 * Hono has no API to unmount a previously-registered route, so instead of trying to remove
 * anything, each call here mounts directly onto the real app at registration time (the plugin id
 * and path are already known then) behind a small "is this still active" flag closed over by the
 * handler. Disposing just flips that flag — the route stays matched by Hono's router forever, but
 * answers `404` from the moment it's disposed, which is indistinguishable from "was never mounted"
 * to any caller (exactly what the task's disposal test needs: "routes 404" after deactivate).
 */

import type { HttpMethod, Origin, RouteInfo } from "@nooklet/plugin-api";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { verifyToken } from "../auth/tokens.js";

export type HandlerRouteSource = {
  kind: "handler";
  method: HttpMethod;
  path: string;
  handler: (req: Request, info: RouteInfo) => Response | Promise<Response>;
  auth: "required" | "none";
};
export type AppRouteSource = { kind: "app"; app: Hono };
export type RouteSource = HandlerRouteSource | AppRouteSource;

function authOrigin(ctx: ServerContext, req: Request): Origin | Response {
  const raw = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const verified = raw ? verifyToken(ctx.driver, raw) : null;
  if (!verified) {
    return new Response(
      JSON.stringify({
        error: { code: "unauthorized", message: "missing or invalid bearer token" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return { kind: "api", tokenId: verified.id };
}

/** Mounts `source` under `/api/plugins/<pluginId>/` on `app`. Returns a disposer (see file
 * header — this does NOT unmount the route, only makes it start 404ing). */
export function mountPluginRoute(
  app: Hono,
  ctx: ServerContext,
  pluginId: string,
  source: RouteSource,
): () => void {
  let active = true;
  const base = `/api/plugins/${pluginId}`;

  if (source.kind === "app") {
    app.all(`${base}/*`, async (c) => {
      if (!active) return c.notFound();
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice(base.length) || "/";
      const forwarded = new Request(url, c.req.raw);
      return source.app.fetch(forwarded);
    });
  } else {
    const fullPath = `${base}${source.path.startsWith("/") ? source.path : `/${source.path}`}`;
    app.on(source.method, fullPath, async (c) => {
      if (!active) return c.notFound();
      let origin: Origin;
      if (source.auth === "none") {
        origin = { kind: "api" };
      } else {
        const result = authOrigin(ctx, c.req.raw);
        if (result instanceof Response) return result;
        origin = result;
      }
      const info: RouteInfo = { params: c.req.param(), origin };
      return source.handler(c.req.raw, info);
    });
  }

  return () => {
    active = false;
  };
}
