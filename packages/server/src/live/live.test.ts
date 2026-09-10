/**
 * `WebSocket /ui/live` against a REAL ephemeral-port server (not just Hono's in-process
 * `app.request`), same reasoning as `../sync/live.test.ts`: the handshake is exercised over an
 * actual `ws` connection wired via `@hono/node-server`'s `websocket: { server }` option.
 */

import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createToken } from "../auth/tokens.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once("open", () => resolve()));
}

function onceMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
}

describe("WebSocket /ui/live", () => {
  let server: ServerType | undefined;
  let wss: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];

  async function startServer(): Promise<TestServer & { port: number }> {
    const base = makeTestServer();
    wss = new WebSocketServer({ noServer: true });
    const port = await new Promise<number>((resolve) => {
      server = serve(
        { fetch: base.app.fetch, port: 0, websocket: { server: wss as WebSocketServer } },
        (info) => resolve(info.port),
      );
    });
    return { ...base, port };
  }

  async function teardown(): Promise<void> {
    for (const ws of sockets.splice(0)) ws.close();
    wss?.close();
    wss = undefined;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = undefined;
  }

  it("registers a window after a hello with a can_sync token, then ui_windows sees it", async () => {
    const s = await startServer();
    try {
      const syncToken = createToken(s.serverCtx.driver, {
        label: "device-a",
        scope: "write",
        canSync: true,
      }).token;
      const uiToken = createToken(s.serverCtx.driver, {
        label: "agent",
        scope: "read",
        uiControl: true,
      }).token;

      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ui/live`);
      sockets.push(ws);
      await onceOpen(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          device_id: "aaaaaaaa",
          window_id: "win-1",
          token: syncToken,
          control_enabled: false,
        }),
      );
      await sleep(50); // let the server process `hello` and register the window

      const { status, json } = await post(s.app, "/api/v1/ui.windows", uiToken, {});
      expect(status).toBe(200);
      expect(json.live).toBe(true);
      expect(json.windows[0]).toMatchObject({ window_id: "win-1", device_id: "aaaaaaaa" });
    } finally {
      await teardown();
    }
  });

  it("closes the connection with an error code when hello carries a non-sync token", async () => {
    const s = await startServer();
    try {
      const noSyncToken = createToken(s.serverCtx.driver, {
        label: "no-sync",
        scope: "write",
      }).token;
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ui/live`);
      sockets.push(ws);
      await onceOpen(ws);
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      ws.send(
        JSON.stringify({
          type: "hello",
          device_id: "bbbbbbbb",
          window_id: "win-2",
          token: noSyncToken,
          control_enabled: false,
        }),
      );
      const code = await closed;
      expect(code).toBe(4403);
    } finally {
      await teardown();
    }
  });

  it("round-trips a real ui_state call: server asks state.get, the real socket answers state.result", async () => {
    const s = await startServer();
    try {
      const syncToken = createToken(s.serverCtx.driver, {
        label: "device-a",
        scope: "write",
        canSync: true,
      }).token;
      const uiToken = createToken(s.serverCtx.driver, {
        label: "agent",
        scope: "read",
        uiControl: true,
      }).token;

      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ui/live`);
      sockets.push(ws);
      await onceOpen(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          device_id: "dddddddd",
          window_id: "win-live",
          token: syncToken,
          control_enabled: false,
        }),
      );
      await sleep(50);

      const nextFromServer = onceMessage(ws);
      const pending = post(s.app, "/api/v1/ui.state", uiToken, {});
      const request = await nextFromServer;
      expect(request.type).toBe("state.get");
      ws.send(
        JSON.stringify({
          type: "state.result",
          request_id: request.request_id,
          state: { window_id: "win-live", page: null },
        }),
      );

      const { status, json } = await pending;
      expect(status).toBe(200);
      expect(json.reachable).toBe(true);
      expect(json.state).toEqual({ window_id: "win-live", page: null });
    } finally {
      await teardown();
    }
  });

  it("ignores malformed / unrecognized frames rather than crashing the connection", async () => {
    const s = await startServer();
    try {
      const syncToken = createToken(s.serverCtx.driver, {
        label: "device-a",
        scope: "write",
        canSync: true,
      }).token;
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ui/live`);
      sockets.push(ws);
      await onceOpen(ws);
      ws.send("not json at all");
      ws.send(JSON.stringify({ type: "not.a.real.type" }));
      await sleep(20);
      // Still usable afterward: a real hello still registers.
      ws.send(
        JSON.stringify({
          type: "hello",
          device_id: "cccccccc",
          window_id: "win-3",
          token: syncToken,
          control_enabled: false,
        }),
      );
      await sleep(50);
      const uiToken = createToken(s.serverCtx.driver, {
        label: "agent",
        scope: "read",
        uiControl: true,
      }).token;
      const { json } = await post(s.app, "/api/v1/ui.windows", uiToken, {});
      expect(json.windows.some((w: { window_id: string }) => w.window_id === "win-3")).toBe(true);
    } finally {
      await teardown();
    }
  });
});
