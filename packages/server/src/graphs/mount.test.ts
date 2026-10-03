/**
 * `createMultiGraphApp`'s dynamic `/g/:graphId/*` dispatch (ADR 025, M1 of the plan this
 * implements): two graphs in one process never see each other's data, an unknown graph id 404s
 * before ever reaching a graph's own auth, and — verifying the composition mechanism empirically
 * rather than trusting the Hono source read alone — a REAL WebSocket connection to one graph's
 * `/sync/live` completes its handshake and gets poked, while a parallel connection to a different
 * graph does not. Mirrors `../sync/live.test.ts`'s "real ephemeral-port server" pattern, since
 * `app.request()` alone (Hono's in-process test helper) never opens an actual socket.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildRegistry } from "../ops/index.js";
import { post } from "../test-helpers.js";
import { createMultiGraphApp } from "./mount.js";
import { GraphRegistry } from "./registry.js";

const ROOT_TOKEN = "test-root-token";

function makeApp(): { app: ReturnType<typeof createMultiGraphApp>; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "nooklet-multigraph-test-"));
  const registry = new GraphRegistry(dataDir, {
    registry: buildRegistry(),
    baseConfig: { timezone: "UTC", port: 0, mirror: { enabled: false } },
  });
  const app = createMultiGraphApp({ dataDir, registry, rootToken: ROOT_TOKEN });
  return { app, dataDir };
}

async function createGraph(
  app: ReturnType<typeof createMultiGraphApp>,
  id: string,
): Promise<string> {
  const res = await post(app, "/graphs", ROOT_TOKEN, { id, label: id });
  expect(res.status).toBe(201);
  return res.json.token as string;
}

describe("createMultiGraphApp: dynamic /g/:graphId/* dispatch", () => {
  it("isolates two graphs — a page created in one is invisible from the other", async () => {
    const { app } = makeApp();
    const tokenA = await createGraph(app, "a");
    const tokenB = await createGraph(app, "b");

    const created = await post(app, "/g/a/api/v1/page.create", tokenA, { name: "Only In A" });
    expect(created.status).toBe(200);

    const listA = await post(app, "/g/a/api/v1/page.list", tokenA, {});
    expect(listA.json.items.map((p: { name: string }) => p.name)).toContain("Only In A");

    const listB = await post(app, "/g/b/api/v1/page.list", tokenB, {});
    expect(listB.json.items.map((p: { name: string }) => p.name)).not.toContain("Only In A");
  });

  it("404s for an unknown graph id before ever checking that graph's own auth", async () => {
    const { app } = makeApp();
    const res = await post(app, "/g/nope/api/v1/page.list", "irrelevant-token", {});
    expect(res.status).toBe(404);
  });

  it("answers a bare, unauthenticated /healthz even when this server hosts zero graphs — what e2e-global-setup.ts and the desktop launcher's reachable() probe poll before anything graph-specific exists", async () => {
    const { app } = makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("a bare, unrouted path 307-redirects to /g/default when a default graph exists", async () => {
    const { app } = makeApp();
    await createGraph(app, "default");
    const res = await app.request("/journals", { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/g/default/journals");
  });

  it("a bare path 404s (not redirects) when no default graph exists", async () => {
    const { app } = makeApp();
    await createGraph(app, "not-default");
    const res = await app.request("/journals", { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("serves /sw.js, /manifest.webmanifest and a workbox chunk unredirected — a service worker registration is rejected outright if its script response is a redirect", async () => {
    const { dataDir } = makeApp();
    const webClientDir = mkdtempSync(join(tmpdir(), "nooklet-webclient-test-"));
    writeFileSync(join(webClientDir, "sw.js"), "self.addEventListener('install', () => {});");
    writeFileSync(join(webClientDir, "manifest.webmanifest"), "{}");
    writeFileSync(join(webClientDir, "workbox-abc123.js"), "// workbox runtime");
    const registry = new GraphRegistry(dataDir, {
      registry: buildRegistry(),
      baseConfig: { timezone: "UTC", port: 0, mirror: { enabled: false } },
    });
    const app = createMultiGraphApp({ dataDir, registry, rootToken: ROOT_TOKEN, webClientDir });

    const sw = await app.request("/sw.js", { redirect: "manual" });
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain("addEventListener");

    const manifest = await app.request("/manifest.webmanifest", { redirect: "manual" });
    expect(manifest.status).toBe(200);

    const workbox = await app.request("/workbox-abc123.js", { redirect: "manual" });
    expect(workbox.status).toBe(200);
    expect(await workbox.text()).toContain("workbox runtime");

    // Not general static serving: an unknown file under the same prefix still 404s, not redirects.
    const missing = await app.request("/workbox-does-not-exist.js", { redirect: "manual" });
    expect(missing.status).toBe(404);
  });

  it("the bare-origin redirect is really followable end to end, POST body and all — not just a Location header in theory", async () => {
    const { app } = makeApp();
    const token = await createGraph(app, "default");

    let server: ServerType | undefined;
    try {
      const port = await new Promise<number>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
      });
      // Real `fetch()`, not Hono's in-process `app.request()` — `app.request()` never actually
      // follows a redirect (there is no client in that path at all, just one handler invocation),
      // so it cannot tell a working redirect from a Location header nobody ever resolves.
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/page.create`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Reached Through Bare Origin" }),
      });
      expect(res.status).toBe(200);
      expect(res.url).toBe(`http://127.0.0.1:${port}/g/default/api/v1/page.create`);

      const list = await post(app, "/g/default/api/v1/page.list", token, {});
      expect(list.json.items.map((p: { name: string }) => p.name)).toContain(
        "Reached Through Bare Origin",
      );
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });

  it("root-token-gates /graphs, independent of any graph's own tokens", async () => {
    const { app } = makeApp();
    const noAuth = await app.request("/graphs");
    expect(noAuth.status).toBe(401);
    const wrongToken = await post(app, "/graphs", "not-the-root-token", { id: "c" });
    expect(wrongToken.status).toBe(401);
  });

  describe("WebSocket /g/:graphId/sync/live", () => {
    let server: ServerType | undefined;
    let wss: WebSocketServer | undefined;
    const sockets: WebSocket[] = [];

    afterEach(async () => {
      for (const ws of sockets.splice(0)) ws.close();
      wss?.close();
      wss = undefined;
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      server = undefined;
    });

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function onceOpen(ws: WebSocket): Promise<void> {
      return new Promise((resolve) => ws.once("open", () => resolve()));
    }
    function onceMessage(ws: WebSocket): Promise<string> {
      return new Promise((resolve) =>
        ws.once("message", (data: Buffer) => resolve(data.toString())),
      );
    }

    async function connectAndHello(
      port: number,
      graphId: string,
      token: string,
    ): Promise<WebSocket> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/g/${graphId}/sync/live`);
      sockets.push(ws);
      await onceOpen(ws);
      ws.send(JSON.stringify({ type: "hello", device_id: "aaaaaaaa", token }));
      await sleep(50);
      return ws;
    }

    it("pokes a connection on the graph an op was pushed to, never a connection on a different graph", async () => {
      const { app } = makeApp();
      const tokenA = await createGraph(app, "a");
      const tokenB = await createGraph(app, "b");

      wss = new WebSocketServer({ noServer: true });
      const port = await new Promise<number>((resolve) => {
        server = serve(
          { fetch: app.fetch, port: 0, websocket: { server: wss as WebSocketServer } },
          (info) => resolve(info.port),
        );
      });

      const wsA = await connectAndHello(port, "a", tokenA);
      const wsB = await connectAndHello(port, "b", tokenB);

      const pokeOnA = onceMessage(wsA);
      let pokedB = false;
      wsB.once("message", () => {
        pokedB = true;
      });

      const res = await post(app, "/g/a/api/v1/page.create", tokenA, { name: "Poke Test" });
      expect(res.status).toBe(200);

      const raw = await pokeOnA;
      expect(JSON.parse(raw)).toMatchObject({ type: "poke" });

      await sleep(100);
      expect(pokedB).toBe(false);
    });
  });
});

/**
 * The iOS app shell loads from `capacitor://localhost`, so every request it makes is cross-origin.
 * Before this, a preflight hit the per-graph bearer gate (401, no CORS headers) and the app could
 * not reach any server at all — shown on the real iOS Simulator by
 * `tools/probes/capacitor-network/` ("TypeError: Load failed" for every fetch).
 */
describe("createMultiGraphApp: CORS for nooklet's own app shells", () => {
  const CAP = "capacitor://localhost";
  const preflight = (origin: string) => ({
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });

  it("answers a Capacitor preflight to a graph route with 204 and the headers it needs — before that graph's own bearer gate", async () => {
    const { app } = makeApp();
    await createGraph(app, "default");
    const res = await app.request("/g/default/api/v1/graph.overview", preflight(CAP));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(CAP);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("answers a preflight at bare origin too, rather than 307-redirecting it (a redirected preflight fails outright)", async () => {
    const { app } = makeApp();
    await createGraph(app, "default");
    const res = await app.request("/graphs", preflight(CAP));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(CAP);
  });

  it("tags the real response for a Capacitor origin, so the app can read it", async () => {
    const { app } = makeApp();
    const token = await createGraph(app, "default");
    const res = await app.request("/g/default/api/v1/graph.overview", {
      method: "POST",
      headers: {
        origin: CAP,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(CAP);
    const session = await app.request("/g/default/api/session", { headers: { origin: CAP } });
    expect(session.headers.get("access-control-allow-origin")).toBe(CAP);
  });

  it("grants nothing to any other origin — /api/session hands a token to loopback callers, so a website must never be able to read it", async () => {
    const { app } = makeApp();
    await createGraph(app, "default");
    const session = await app.request("/g/default/api/session", {
      headers: { origin: "https://evil.example" },
    });
    expect(session.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app.request(
      "/g/default/api/v1/graph.overview",
      preflight("https://evil.example"),
    );
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(pre.status).toBe(401); // unchanged: falls through to the graph's own bearer gate
  });
});
