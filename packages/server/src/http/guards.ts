/**
 * Request guards for one graph's app, installed FIRST, before any route: Host allowlist, security
 * headers, body size limit, and deny-by-default bearer auth. `docs/spec/security-inventory.md` is
 * the human-readable list of what is public; `PUBLIC_ROUTES` below is the enforced one, and
 * `./route-inventory.test.ts` fails if a registered route is reachable without a token and is not
 * on it.
 *
 * Why "first" matters: Hono runs handlers in registration order, and a route that answers stops the
 * chain. Plugin routes (`../plugins/routes.ts`) and `/plugins/:id/:file` are registered by
 * `createAppWithPlugins` BEFORE `createApp` runs, so a guard added inside `createApp` never ran for
 * them — the Host (DNS-rebinding) guard was silently skipped there
 * (`tools/probes/security/unauth-surface.mjs`: `/g/default/plugins/x/client.x.js` answered 200 to
 * `Host: evil.example` while every other route answered 403).
 *
 * Why deny-by-default: auth used to be opted into per mount (`/api/v1/*` middleware, a helper call
 * inside each sync route, the MCP library's gate, a flag on each plugin route). A new route that
 * forgot its line was public. Now every request needs a valid token unless it is
 *   1. on `PUBLIC_ROUTES` (or a plugin route registered with `auth: "none"`), or
 *   2. a GET/HEAD outside the reserved API prefixes — the static web client and its SPA fallback,
 *      which serve build artifacts only.
 * Routes keep their own, stricter checks (scope per op, `can_sync` for sync, the root token for
 * `/graphs`); this layer only guarantees "no token, no data".
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerContext } from "../apply-ops.js";
import { bearerAuth } from "../auth/tokens.js";
import type { ServerConfig } from "../ops/registry.js";
import { allowedHostNames, hostName, isLoopbackName, rejectHost } from "./host-names.js";

export interface PublicRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
  /** Hono-style pattern: `:param` matches one segment, a trailing `/*` any rest. */
  path: string;
  /** Public only as a WebSocket handshake (`Upgrade: websocket`); a plain GET still needs a token.
   * These authenticate in their first message — a browser cannot set a header on a WS handshake. */
  websocket?: true;
  /** Why this is public. Mirrored in `docs/spec/security-inventory.md`. */
  why: string;
}

/** Every route a client may reach without a token, per graph (paths are inside `/g/<id>`). */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: "GET", path: "/healthz", why: "liveness probe; constant JSON" },
  {
    method: "GET",
    path: "/api/session",
    why: "how a client without a token learns the graph id; a token only for a loopback peer",
  },
  { method: "GET", path: "/openapi.json", why: "API description; no graph data" },
  {
    method: "GET",
    path: "/assets/:id",
    why: "<img src> cannot carry a bearer header; ids are unguessable, served with CSP sandbox",
  },
  {
    method: "GET",
    path: "/plugins/:id/:file",
    why: "client plugin bundles loaded by import(); content-hashed build output, no graph data",
  },
  {
    method: "POST",
    path: "/api/v1/pairing.redeem",
    why: 'a new device trades a one-time pairing code for its first token; it has no token yet. 128-bit single-use codes, 10-minute expiry, rate-limited (./rate-limit.ts). The op is also marked auth: "none"; both are needed',
  },
  {
    method: "GET",
    path: "/sync/live",
    websocket: true,
    why: "authenticates with a can_sync token in its first message",
  },
  {
    method: "GET",
    path: "/ui/live",
    websocket: true,
    why: "authenticates with a can_sync token in its first message",
  },
];

/**
 * The process-level app's public routes (`../graphs/mount.ts`, outside any `/g/<id>`). Everything
 * else there is `/graphs` (root token) or the `/g/*` dispatcher into a graph's guarded app. The
 * bare-origin fallback (`*`) only redirects to `/g/default/...` or answers 404.
 */
export const OUTER_PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: "GET", path: "/healthz", why: "process liveness probe (k8s, desktop launcher)" },
  { method: "GET", path: "/sw.js", why: "service worker script; must not be a redirect" },
  { method: "GET", path: "/manifest.webmanifest", why: "PWA manifest; build output" },
  { method: "GET", path: "/workbox-*", why: "service worker runtime chunk; build output" },
  { method: "ALL", path: "/g/*", why: "dispatch into a graph's own guarded app" },
  { method: "ALL", path: "*", why: "bare-origin fallback: 307 to /g/default/... or 404" },
];

/**
 * Path prefixes that belong to the API. A GET under one of these is NOT treated as a web-client
 * page load, so it needs a token unless `PUBLIC_ROUTES` names it. Everything outside them that is
 * a GET/HEAD is the static client (`./web-client.ts`), which the route-inventory test checks has
 * no registered route of its own.
 */
export const RESERVED_PREFIXES: readonly string[] = [
  "/api",
  "/sync",
  "/ui",
  "/mcp",
  "/graphs",
  "/assets",
  "/plugins",
  "/openapi.json",
];

export function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** `:param` = one non-empty segment; trailing `/*` = anything (including nothing) after. */
export function matchesPattern(pattern: string, path: string): boolean {
  const pat = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i] as string;
    if (p === "*" && i === pat.length - 1) return true;
    const g = got[i];
    if (g === undefined) return false;
    if (p.startsWith(":")) continue;
    if (p !== g) return false;
  }
  return pat.length === got.length;
}

/** Plugin routes registered with `auth: "none"` (`../plugins/routes.ts`), per app. They are the
 * plugin author's explicit choice, so they are public — but listed, so the inventory test sees
 * them and `GET /api/v1/plugins` callers can too. */
const pluginPublicRoutes = new WeakMap<Hono, PublicRoute[]>();

export function allowPublicRoute(app: Hono, route: PublicRoute): void {
  const list = pluginPublicRoutes.get(app) ?? [];
  list.push(route);
  pluginPublicRoutes.set(app, list);
}

export function publicRoutesFor(app: Hono): readonly PublicRoute[] {
  return [...PUBLIC_ROUTES, ...(pluginPublicRoutes.get(app) ?? [])];
}

function isPublic(app: Hono, c: Context): boolean {
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  const path = c.req.path;
  for (const r of publicRoutesFor(app)) {
    if (r.method !== "ALL" && r.method !== method) continue;
    if (!matchesPattern(r.path, path)) continue;
    if (r.websocket && c.req.header("upgrade")?.toLowerCase() !== "websocket") continue;
    return true;
  }
  // The static web client: build artifacts and the SPA shell. Nothing under an API prefix.
  return method === "GET" && !isReservedPath(path);
}

/**
 * Request body caps. Without them every authenticated endpoint read the whole body into memory
 * before validating it: 300 MB to `page.list` took the server from 206 MB to 1.46 GB RSS
 * (`tools/probes/security/body-size.mjs`). The large cap covers the routes that legitimately carry
 * an asset (25 MB decoded is ~33.4 MB of base64, `../assets/store.ts#MAX_ASSET_BYTES`) or a sync
 * batch of up to 200 ops; everything else is ordinary JSON.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_LARGE_BODY_BYTES = 48 * 1024 * 1024;
const LARGE_BODY_PATHS = ["/api/v1/asset.upload", "/mcp", "/sync/push"];

function tooLarge(c: Context): Response {
  return c.json({ error: { code: "too_large", message: "request body is too large" } }, 413);
}
const smallBodies = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
const largeBodies = bodyLimit({ maxSize: MAX_LARGE_BODY_BYTES, onError: tooLarge });

export const limitBody: MiddlewareHandler = (c, next) =>
  LARGE_BODY_PATHS.includes(c.req.path) ? largeBodies(c, next) : smallBodies(c, next);

/**
 * Headers every response carries. The CSP for the app shell itself is set where the HTML is built
 * (`./web-client.ts#shellCsp`), because it has to name the hashes of that document's inline
 * scripts. Set only when absent, so a route's own stricter value (assets' `sandbox`) wins.
 *
 * HSTS only when the request arrived over TLS — in practice, through a TLS proxy that says so in
 * `X-Forwarded-Proto` (or `Forwarded: proto=https`). Browsers ignore HSTS on plain http anyway; the
 * condition just keeps the header off a tailnet-http or loopback response where it means nothing.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  // A 101 Switching Protocols must go out exactly as the WebSocket adapter built it.
  if (c.req.header("upgrade")) return;
  const set: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
  if (arrivedOverTls(c)) set["strict-transport-security"] = "max-age=31536000";
  try {
    for (const [k, v] of Object.entries(set)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  } catch {
    // Immutable headers (a `Response.redirect`): copy once, then set.
    c.res = new Response(c.res.body, c.res);
    for (const [k, v] of Object.entries(set)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  }
};

function arrivedOverTls(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const xfp = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (xfp === "https") return true;
  return /(?:^|[;,\s])proto=(?:"?)https\b/i.test(c.req.header("forwarded") ?? "");
}

const installed = new WeakSet<Hono>();

/**
 * Installs the guards on `app`, once. Call before registering any route (`createAppWithPlugins`
 * does; `createApp` calls it too, which is a no-op when it was already done).
 */
export function installRequestGuards(
  app: Hono,
  serverCtx: ServerContext,
  config: ServerConfig,
): void {
  if (installed.has(app)) return;
  installed.add(app);

  app.use("*", securityHeaders);

  // DNS-rebinding / unexpected-Host guard. Only enforced when bound to a non-loopback address: on
  // loopback the peer is already this machine, and a same-host proxy that rewrites Host (B-616)
  // would otherwise need --allow-host. That trade is listed in the hardening backlog.
  // `/mcp` is Host-checked even on a loopback bind (B-616: the MCP library's own guard did that,
  // and its 403 names the `--allow-host` to add); here it runs before auth, so a wrong Host gets
  // that 403 rather than a 401 that hides the cause.
  const boundHost = config.host ?? "127.0.0.1";
  const allowed = allowedHostNames(config);
  const checkAll = !isLoopbackName(boundHost);
  app.use("*", async (c, next) => {
    if (!checkAll && c.req.path !== "/mcp" && !c.req.path.startsWith("/mcp/")) return next();
    if (!allowed.has(hostName(c.req.header("host")))) return rejectHost(c, c.req.header("host"));
    return next();
  });

  const auth = bearerAuth(serverCtx.driver);
  app.use("*", async (c, next) => {
    if (isPublic(app, c)) return next();
    return auth(c, next);
  });

  app.use("*", limitBody);
}
