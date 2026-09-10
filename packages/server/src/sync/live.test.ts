/**
 * WebSocket poke test against a REAL ephemeral-port server (not just Hono's in-process
 * `app.request`), since the poke is delivered over an actual `ws` connection wired via
 * `@hono/node-server`'s `websocket: { server }` option — the same wiring `../cli.ts` uses.
 */

import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { Hlc, makeOp, newId } from "@nooklet/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { post } from "../test-helpers.js";
import { makeSyncTestServer } from "./sync-test-helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data: Buffer) => resolve(data.toString()));
  });
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once("open", () => resolve()));
}

describe("WebSocket /sync/live", () => {
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

  async function startServer(): Promise<ReturnType<typeof makeSyncTestServer> & { port: number }> {
    const testServer = makeSyncTestServer();
    wss = new WebSocketServer({ noServer: true });
    const port = await new Promise<number>((resolve) => {
      server = serve(
        { fetch: testServer.app.fetch, port: 0, websocket: { server: wss as WebSocketServer } },
        (info) => resolve(info.port),
      );
    });
    return { ...testServer, port };
  }

  async function connectAndHello(
    port: number,
    deviceId: string,
    token: string,
  ): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/live`);
    sockets.push(ws);
    await onceOpen(ws);
    ws.send(JSON.stringify({ type: "hello", device_id: deviceId, token }));
    await sleep(50); // let the server process `hello` and register the connection
    return ws;
  }

  it("pokes a connected device (but not the pushing one) when a push commits", async () => {
    const { app, syncToken, syncToken2, port } = await startServer();

    const wsA = await connectAndHello(port, "aaaaaaaa", syncToken);
    const wsB = await connectAndHello(port, "bbbbbbbb", syncToken2);

    const pokeOnB = onceMessage(wsB);
    let pokedA = false;
    wsA.once("message", () => {
      pokedA = true;
    });

    const clock = new Hlc("aaaaaaaa");
    const op = makeOp(clock.next(), "aaaaaaaa", newId(), {
      kind: "page.create",
      name: "Live Poke",
      journalDay: null,
      createdAt: Date.now(),
    });
    const pushRes = await post(app, "/sync/push", syncToken, {
      device_id: "aaaaaaaa",
      ops: [op],
    });
    expect(pushRes.json.rejected).toEqual([]);

    const raw = await pokeOnB;
    expect(JSON.parse(raw)).toEqual({ type: "poke", seq: pushRes.json.server_seq });

    await sleep(100);
    expect(pokedA).toBe(false);
  });

  it("pokes connected devices when an API/MCP write commits, not just a sync push", async () => {
    // Without this, an agent editing over MCP while someone watches the app would appear to do
    // nothing until that client next pulled — the live-collaboration case ADR 015 is built on.
    // `../ops/registry.ts`'s `applyOps` calls `notifyCommit` for exactly this reason.
    const { app, syncToken, writeToken, port } = await startServer();
    const ws = await connectAndHello(port, "aaaaaaaa", syncToken);
    const poke = onceMessage(ws);

    const res = await post(app, "/api/v1/page.create", writeToken, { name: "Written By Agent" });
    expect(res.status).toBe(200);

    const raw = await poke;
    const parsed = JSON.parse(raw) as { type: string; seq: number };
    expect(parsed.type).toBe("poke");
    expect(parsed.seq).toBeGreaterThan(0);
  });

  it("closes the connection with an error code when hello carries a non-sync token", async () => {
    const { port, writeToken } = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/live`);
    sockets.push(ws);
    await onceOpen(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ type: "hello", device_id: "cccccccc", token: writeToken }));
    const code = await closed;
    expect(code).toBe(4403);
  });
});
