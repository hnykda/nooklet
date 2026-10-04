/**
 * Enforces `docs/spec/security-inventory.md`: every route actually registered on a graph's app
 * (with the built-in plugins loaded, as `nooklet serve` does) and on the process-level app either
 * refuses a request that carries no token, or is on the public allowlist in `./guards.ts`. A new
 * route that is reachable without a token and not on that list fails here — whoever adds it has
 * to put it on the list, with a reason, on purpose.
 *
 * It probes rather than compares lists: each registered pattern is turned into a concrete request
 * and sent with no `Authorization`. That catches a route whose own check is missing, not only one
 * whose name is missing from a list.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMultiGraphApp } from "../graphs/mount.js";
import { pluginDirsFor } from "../graphs/plugin-dirs.js";
import { GraphRegistry } from "../graphs/registry.js";
import { buildRegistry } from "../ops/index.js";
import {
  matchesPattern,
  OUTER_PUBLIC_ROUTES,
  PUBLIC_ROUTES,
  type PublicRoute,
  publicRoutesFor,
} from "./guards.js";

const ROOT_TOKEN = "test-root-token";

async function makeServer(): Promise<{ outer: Hono; graph: Hono }> {
  const dataDir = mkdtempSync(join(tmpdir(), "nooklet-inventory-"));
  const webDir = mkdtempSync(join(tmpdir(), "nooklet-inventory-web-"));
  writeFileSync(join(webDir, "index.html"), "<html><head></head><body>shell</body></html>");
  writeFileSync(join(webDir, "sw.js"), "/* sw */");
  const plugins = pluginDirsFor(dataDir);
  const registry = new GraphRegistry(dataDir, {
    registry: buildRegistry(),
    webClientDir: webDir,
    baseConfig: { timezone: "UTC", port: 0, mirror: { enabled: false } },
  });
  // Sanity: the built-in plugins must actually be loaded, or their routes go unchecked.
  expect(plugins.dirs.length + plugins.bundled.length).toBeGreaterThan(0);
  const outer = createMultiGraphApp({
    dataDir,
    registry,
    rootToken: ROOT_TOKEN,
    webClientDir: webDir,
  });
  await registry.create("default");
  const handle = await registry.resolve("default");
  if (!handle) throw new Error("no default graph");
  return { outer, graph: handle.app };
}

/** Registered `(method, path)` pairs, minus the global `*` middleware (guards, CORS, headers),
 * which is not a route. A real catch-all route would be `*` too; the outer app has exactly one,
 * on `OUTER_PUBLIC_ROUTES`, and it is checked separately below. */
function registered(app: Hono): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (r.path === "*" || r.path === "/*") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

function concrete(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "x" : seg === "*" ? "x" : seg.replace(/\*$/, "x")))
    .join("/")
    .replace(/\{[^}]*\}/g, "");
}

function listed(list: readonly PublicRoute[], method: string, path: string): boolean {
  return list.some(
    (p) =>
      (p.method === "ALL" || method === "ALL" || p.method === method) &&
      (p.path === path || matchesPattern(p.path, concrete(path))),
  );
}

describe("route inventory: deny by default (docs/spec/security-inventory.md)", () => {
  it("every registered graph route refuses an unauthenticated request unless it is on PUBLIC_ROUTES", async () => {
    const { graph } = await makeServer();
    const routes = registered(graph);
    // The plugin and MCP mounts must be part of what is checked, not silently absent.
    expect(routes.some((r) => r.path.startsWith("/mcp"))).toBe(true);
    expect(routes.some((r) => r.path.startsWith("/api/v1/"))).toBe(true);
    expect(routes.some((r) => r.path === "/plugins/:id/:file")).toBe(true);

    const leaks: string[] = [];
    for (const r of routes) {
      if (listed(publicRoutesFor(graph), r.method, r.path)) continue;
      const methods = r.method === "ALL" ? ["GET", "POST"] : [r.method];
      for (const method of methods) {
        const res = await graph.request(concrete(r.path), {
          method,
          headers: { host: "localhost", "content-type": "application/json" },
          body: method === "GET" || method === "HEAD" ? undefined : "{}",
        });
        if (res.status !== 401) leaks.push(`${method} ${r.path} -> ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("every PUBLIC_ROUTES entry is a route that exists (no stale allowlist)", async () => {
    const { graph } = await makeServer();
    const routes = registered(graph);
    for (const p of PUBLIC_ROUTES) {
      expect(
        routes.some((r) => r.path === p.path && (r.method === p.method || r.method === "ALL")),
        `${p.method} ${p.path}`,
      ).toBe(true);
    }
  });

  it("a WebSocket route is public only as a handshake; a plain GET needs a token", async () => {
    const { graph } = await makeServer();
    for (const path of ["/sync/live", "/ui/live"]) {
      expect((await graph.request(path)).status).toBe(401);
    }
  });

  it("unregistered paths: API prefixes and non-GET methods need a token, GET elsewhere is the shell", async () => {
    const { graph } = await makeServer();
    expect((await graph.request("/api/v1/no.such.op", { method: "POST" })).status).toBe(401);
    expect((await graph.request("/api/anything")).status).toBe(401);
    expect((await graph.request("/sync/whatever")).status).toBe(401);
    expect((await graph.request("/some/page", { method: "POST" })).status).toBe(401);
    // Percent-encoding cannot step around a prefix: Hono decodes before routing and so does the guard.
    expect((await graph.request("/%61pi/v1/page.list", { method: "POST" })).status).toBe(401);
    const shell = await graph.request("/page/Anything", { headers: { accept: "text/html" } });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("shell");
  });

  it("every process-level route is root-token gated or on OUTER_PUBLIC_ROUTES", async () => {
    const { outer } = await makeServer();
    const leaks: string[] = [];
    for (const r of outer.routes) {
      if (listed(OUTER_PUBLIC_ROUTES, r.method, r.path)) continue;
      const methods = r.method === "ALL" ? ["GET", "POST"] : [r.method];
      for (const method of methods) {
        const res = await outer.request(concrete(r.path), {
          method,
          headers: { host: "localhost", "content-type": "application/json" },
          body: method === "GET" ? undefined : "{}",
        });
        if (res.status !== 401) leaks.push(`${method} ${r.path} -> ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(outer.routes.some((r) => r.path.startsWith("/graphs"))).toBe(true);
  });
});
