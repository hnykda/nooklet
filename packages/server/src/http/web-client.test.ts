import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestServer, post } from "../test-helpers.js";
import { mountWebClient } from "./web-client.js";

/** A minimal stand-in for a real `apps/web/dist`. */
function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-web-"));
  mkdirSync(join(dir, "static"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>nooklet</title>");
  writeFileSync(join(dir, "static", "index-abc123.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "sw.js"), "/* service worker */\n");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"nooklet"}');
  writeFileSync(join(dir, "sqlite3.wasm"), "\0asm");
  return dir;
}

// Every real client sends Host; `app.request()` does not, and the MCP sub-app's DNS-rebinding
// guard (mounted at "/" and therefore governing the SPA fallback) rejects a request without one.
const HOST = { host: "127.0.0.1:6100" };
const HTML = { ...HOST, accept: "text/html,application/xhtml+xml" };

describe("mountWebClient", () => {
  let dist: string;
  let app: Hono;

  beforeAll(() => {
    dist = makeDist();
    app = new Hono();
    app.get("/api/v1/thing", (c) => c.json({ ok: true }));
    mountWebClient(app, { dir: dist });
  });

  it("serves index.html at the root even without an HTML Accept header", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("nooklet");
  });

  it("falls back to the shell for client-side routes, so a reload or pasted link works", async () => {
    const res = await app.request("/page/Some%20Page", { headers: HTML });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("serves hashed build output immutably and everything else revalidating", async () => {
    const hashed = await app.request("/static/index-abc123.js");
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(hashed.headers.get("content-type")).toContain("text/javascript");

    // A service worker cached forever would outlive every future deploy.
    const sw = await app.request("/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
  });

  it("sets the content types that browsers refuse to work without", async () => {
    const wasm = await app.request("/sqlite3.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    const manifest = await app.request("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
  });

  it("never shadows a real route", async () => {
    const res = await app.request("/api/v1/thing");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s a non-GET that fell through, rather than answering HTML to a JSON caller", async () => {
    const res = await app.request("/api/v1/nope", { method: "POST", headers: HTML });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("404s a fetch that did not ask for HTML, so a broken request fails loudly", async () => {
    const res = await app.request("/api/v1/nope", { headers: { accept: "application/json" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("refuses to escape the client directory", async () => {
    for (const path of [
      "/../../etc/passwd",
      "/static/../../../../etc/passwd",
      "/%2e%2e/index.js",
    ]) {
      const res = await app.request(path, { headers: { accept: "application/json" } });
      expect(res.status, path).toBe(404);
    }
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await app.request("/static/index-abc123.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("");
  });
});

describe("createApp with a web client", () => {
  it("keeps the API, /healthz and /mcp reachable while serving the app at /", async () => {
    const s = makeTestServer({ webClientDir: makeDist() });

    const root = await s.app.request("/", { headers: HOST });
    expect(root.headers.get("content-type")).toContain("text/html");

    // The JSON liveness probe moves to /healthz once / belongs to the app.
    const health = await s.app.request("/healthz", { headers: HOST });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ name: "nooklet", status: "ok" });

    const api = await post(s.app, "/api/v1/graph.overview", s.readToken, {});
    expect(api.status).toBe(200);

    const spec = await s.app.request("/openapi.json", { headers: HOST });
    expect(spec.status).toBe(200);

    // The MCP sub-app is mounted at "/" and the client is installed as `notFound`; neither may
    // swallow the other.
    const mcp = await s.app.request("/mcp", {
      method: "POST",
      headers: {
        ...HOST,
        authorization: `Bearer ${s.readToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("graph_overview");
  });

  it("still answers / with JSON when no web client is configured", async () => {
    const s = makeTestServer();
    const root = await s.app.request("/", { headers: HOST });
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ name: "nooklet" });
  });

  // The regression this guards: the MCP sub-app's DNS-rebinding middleware is installed app-wide,
  // so without an allowlist the SPA fallback 403s for anyone opening the app by a LAN address —
  // i.e. "serve my graph to my phone" silently fails while curl from localhost looks fine.
  it("refuses a LAN Host by default and accepts one that was allowlisted", async () => {
    const dist = makeDist();
    const lan = { host: "192.168.1.5:6100", accept: "text/html" };

    // Bound to a LAN address: nooklet's own Host guard refuses an unlisted name.
    const closed = makeTestServer({ webClientDir: dist, host: "0.0.0.0" });
    expect((await closed.app.request("/", { headers: lan })).status).toBe(403);

    const open = makeTestServer({
      webClientDir: dist,
      host: "0.0.0.0",
      allowedHosts: ["192.168.1.5"],
    });
    const res = await open.app.request("/", { headers: lan });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // Loopback keeps working alongside the added host, not instead of it.
    expect((await open.app.request("/", { headers: HOST })).status).toBe(200);
  });

  it("serves the app shell behind a same-host proxy that rewrites Host (B-616)", async () => {
    // Bound to loopback, a proxy on this machine forwards `Host: nooklet.example`. The shell used
    // to get 403 `{"jsonrpc":…,"Invalid Host"}` from the MCP sub-app's guard, which was mounted at
    // "/" and so ran for the SPA fallback, while `/api/session` answered 200.
    const proxied = { host: "nooklet.example", accept: "text/html" };
    const s = makeTestServer({ webClientDir: makeDist() });
    const shell = await s.app.request("/", { headers: proxied });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect((await s.app.request("/journals", { headers: proxied })).status).toBe(200);
    expect((await s.app.request("/api/session", { headers: proxied })).status).toBe(200);

    // /mcp stays guarded, with nooklet's own message naming the fix...
    const mcp = await s.app.request("/mcp", {
      method: "POST",
      headers: { ...proxied, "content-type": "application/json", accept: "application/json" },
      body: "{}",
    });
    expect(mcp.status).toBe(403);
    expect(((await mcp.json()) as { error: { message: string } }).error.message).toContain(
      "--allow-host nooklet.example",
    );
    // ...and follows --allow-host on a loopback bind too (it used to be localhost-only there).
    const allowed = makeTestServer({ allowedHosts: ["nooklet.example"] });
    const mcpAllowed = await allowed.app.request("/mcp", {
      method: "POST",
      headers: { ...proxied, "content-type": "application/json", accept: "application/json" },
      body: "{}",
    });
    expect(mcpAllowed.status).not.toBe(403);
  });
});
