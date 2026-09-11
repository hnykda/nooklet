/**
 * Serves the built web client (`apps/web/dist`) from the same origin as the API.
 *
 * Why this exists: until now `nooklet serve` served only the API, and the client was a separate
 * Vite dev server. That is fine for development and impossible for everything else — a desktop
 * bundle, a home server you open from your phone, or a Tailscale-reachable graph all need one
 * process handing out both the app and its data. Same-origin also makes the client's own
 * `fetch("/api/v1/…")` and `ws://…/sync/live` work with no configured base URL at all.
 *
 * Two deliberate choices:
 *
 * 1. **Hand-rolled instead of `@hono/node-server/serve-static`.** That helper resolves its `root`
 *    relative to `process.cwd()`, which is unknowable inside a packaged app (the user launches
 *    from Finder, cwd is `/`). Everything here takes an absolute directory.
 *
 * 2. **Installed as `notFound`, not as routes.** `createApp` merges the MCP sub-app at `"/"`
 *    (`../mcp/server.ts`), which matches every path, so any route registered afterwards risks
 *    being shadowed and anything registered before would shadow `/mcp` itself. The not-found hook
 *    is the one place that runs strictly after every real route has declined, so the client can
 *    never intercept an API, sync, or MCP request no matter how the paths evolve.
 *
 * The SPA fallback (`/whatever/deep/route` → `index.html`) is what makes client-side routing
 * survive a reload or a pasted link.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";

/** Extension → content type. Deliberately small: this serves one known Vite build, not arbitrary
 * user files. `.wasm` matters (SQLite WASM refuses to stream-compile without it) and so does
 * `.webmanifest` (installability). */
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (
    (dot === -1 ? undefined : CONTENT_TYPES.get(path.slice(dot))) ?? "application/octet-stream"
  );
}

/**
 * Vite emits hashed filenames under `build.assetsDir`, which we set to `static/` (NOT the default
 * `assets/`, which would collide with the graph's own `/assets/:id` route — see
 * `apps/web/vite.config.ts`). Those names change whenever content changes, so they are safe to
 * cache forever; everything else must be revalidated or a stale service worker outlives a deploy.
 */
function cacheControl(pathname: string): string {
  if (pathname.startsWith("/static/")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

/** Resolves a URL path to a file inside `root`, or `null` if it escapes or is not a file.
 * The containment check is what stops `GET /../../etc/passwd` and its encoded variants — the URL
 * is already percent-decoded by the time Hono hands us `pathname`. */
async function resolveFile(root: string, pathname: string): Promise<string | null> {
  const candidate = resolve(join(root, normalize(pathname)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function bodyOf(path: string): ReadableStream {
  return Readable.toWeb(createReadStream(path)) as ReadableStream;
}

export interface WebClientOptions {
  /** Absolute path to the built client (the directory containing `index.html`). */
  dir: string;
}

/**
 * Installs the web client as the app's not-found handler. Call AFTER every API/sync/MCP route is
 * mounted; `createApp` does this for you when `webClientDir` is set.
 */
export function mountWebClient(app: Hono, opts: WebClientOptions): void {
  const root = resolve(opts.dir);
  const indexPath = join(root, "index.html");

  app.notFound(async (c) => {
    // Only GET/HEAD can be a page load. A POST that fell through to here is a genuinely unknown
    // endpoint and must stay a 404, not silently return HTML to a client expecting JSON.
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return c.json({ error: { code: "not_found", message: "Not Found" } }, 404);
    }

    const pathname = new URL(c.req.url).pathname;
    const file = await resolveFile(root, pathname);
    if (file) {
      const headers = {
        "content-type": contentType(file),
        "cache-control": cacheControl(pathname),
      };
      return method === "HEAD"
        ? new Response(null, { headers })
        : new Response(bodyOf(file), { headers });
    }

    // SPA fallback: an unmatched path is a client-side route, so hand back the shell and let the
    // router sort it out. Requests that clearly want data (an `Accept` without HTML — an API probe,
    // an `<img>` for a deleted asset) get a real 404 instead, so a broken fetch fails loudly rather
    // than "succeeding" with a page of HTML.
    const wantsHtml = pathname === "/" || (c.req.header("accept") ?? "").includes("text/html");
    if (!wantsHtml) {
      return c.json({ error: { code: "not_found", message: "Not Found" } }, 404);
    }
    const shell = await resolveFile(root, "/index.html");
    if (!shell) {
      return c.json(
        {
          error: {
            code: "web_client_missing",
            message: `No index.html in ${root}. Build the client first (pnpm --filter @nooklet/web build).`,
          },
        },
        404,
      );
    }
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
    return method === "HEAD"
      ? new Response(null, { headers })
      : new Response(bodyOf(indexPath), { headers });
  });
}
