/** Shared test scaffolding (not itself a `*.test.ts` file, so vitest ignores it). */

import type { Hono } from "hono";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createToken } from "./auth/tokens.js";
import { openDb } from "./db.js";
import { createApp } from "./http/app.js";
import { buildRegistry } from "./ops/index.js";
import type { OpRegistry, ServerConfig } from "./ops/registry.js";

export interface TestServer {
  app: Hono;
  serverCtx: ServerContext;
  registry: OpRegistry;
  config: ServerConfig;
  writeToken: string;
  readToken: string;
  adminToken: string;
}

export function makeTestServer(): TestServer {
  const serverCtx = createServerContext(openDb({ path: ":memory:" }));
  const registry = buildRegistry();
  const config: ServerConfig = {
    dataDir: ":memory:",
    graphId: "default",
    timezone: "UTC",
    port: 0,
    mirror: { enabled: false },
  };
  const app = createApp({ serverCtx, registry, config, version: "0.0.1-test" });
  const writeToken = createToken(serverCtx.driver, { label: "test-write", scope: "write" }).token;
  const readToken = createToken(serverCtx.driver, { label: "test-read", scope: "read" }).token;
  const adminToken = createToken(serverCtx.driver, { label: "test-admin", scope: "admin" }).token;
  return { app, serverCtx, registry, config, writeToken, readToken, adminToken };
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function post(app: Hono, path: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}
