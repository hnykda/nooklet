/** Shared plugin-test scaffolding (not itself a `*.test.ts` file, so vitest ignores it — same
 * pattern as `../test-helpers.ts`). Fixtures are written to REAL temp directories (not `:memory:`)
 * since the loader discovers/bundles from disk. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { createServerContext, type ServerContext } from "../apply-ops.js";
import { createToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { buildRegistry } from "../ops/index.js";
import type { OpRegistry, ServerConfig } from "../ops/registry.js";
import { createAppWithPlugins } from "./bootstrap.js";
import type { PluginHost } from "./host.js";

export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes a package-form plugin fixture at `<root>/<id>/package.json` (+ any given source files)
 * and returns its directory. `nooklet` is the manifest object (`package.json#nooklet`); pass
 * whatever `files` the manifest's `server`/`client` paths need (e.g. `{"src/server.ts": "..."}`). */
export function writePluginFixture(
  root: string,
  id: string,
  nooklet: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: `nooklet-plugin-${id}`, version: "0.1.0", type: "module", nooklet },
      null,
      2,
    ),
  );
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(dir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

export interface PluginTestSetup {
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  app: Hono;
  host: PluginHost;
  writeToken: string;
  readToken: string;
  adminToken: string;
}

/** Builds a full app + plugin host (via `./bootstrap.ts`'s `createAppWithPlugins`, the same path
 * `nooklet serve` uses) against an in-memory DB, discovering plugins from `pluginDirs` and
 * activating the enabled ones. */
export async function makePluginTestSetup(
  pluginDirs: string[],
  bundledPluginDirs?: string[],
): Promise<PluginTestSetup> {
  const serverCtx = createServerContext(openDb({ path: ":memory:" }));
  const registry = buildRegistry();
  const config: ServerConfig = {
    dataDir: tmpDir("nooklet-plugin-data-"),
    graphId: "default",
    timezone: "UTC",
    port: 0,
    mirror: { enabled: false },
  };
  const { app, pluginHost } = await createAppWithPlugins({
    serverCtx,
    registry,
    config,
    version: "0.0.1-test",
    pluginDirs,
    bundledPluginDirs,
  });
  const writeToken = createToken(serverCtx.driver, { label: "test-write", scope: "write" }).token;
  const readToken = createToken(serverCtx.driver, { label: "test-read", scope: "read" }).token;
  const adminToken = createToken(serverCtx.driver, { label: "test-admin", scope: "admin" }).token;
  return { serverCtx, registry, config, app, host: pluginHost, writeToken, readToken, adminToken };
}

export { authHeaders, post } from "../test-helpers.js";

/** Same JSON-RPC-over-`/mcp` helper `../mcp/server.test.ts` uses, so plugin MCP tests can check
 * `tools/list`/`tools/call` the same way core op MCP tests do. */
export async function mcpRpc(
  app: Hono,
  token: string,
  method: string,
  params: unknown,
  id = 1,
  // biome-ignore lint/suspicious/noExplicitAny: test helper — callers assert on whatever shape their fixture produces
): Promise<{ status: number; body: any }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    return {
      status: res.status,
      body: dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined,
    };
  }
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}
