/**
 * `WebSocket /sync/live` (ADR 003 / research/03-sync.md §6.5): "poke only, no payload". A client
 * connects, sends `{type:'hello', device_id, token}` (a WS handshake cannot carry a bearer header
 * from a browser, hence the first-message auth), and from then on receives `{type:'poke', seq}`
 * whenever some OTHER device's push commits — the poke carries no ops; the client is expected to
 * then call `GET /sync/pull`.
 *
 * Uses `@hono/node-server`'s `upgradeWebSocket` + a `ws` `WebSocketServer` (see `../cli.ts`'s
 * `serve({..., websocket: {server}})` call) — the simplest thing that works with the existing
 * `createApp`/`serve` wiring, per the its own README ("You can upgrade WebSocket connections with
 * `upgradeWebSocket` from `@hono/node-server`... create and provide a `WebSocketServer`").
 */

import { upgradeWebSocket } from "@hono/node-server";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import {
  trackGraphSocket,
  trackTokenSocket,
  untrackGraphSocket,
  untrackTokenSocket,
} from "../auth/token-sockets.js";
import { verifyToken } from "../auth/tokens.js";
import { registerLiveConnection, unregisterLiveConnection, wirePokeOnCommit } from "./realtime.js";

interface HelloMessage {
  type: "hello";
  device_id: string;
  token: string;
}

function isHello(x: unknown): x is HelloMessage {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.type === "hello" && typeof o.device_id === "string" && typeof o.token === "string";
}

export function registerSyncLive(app: Hono, serverCtx: ServerContext): void {
  wirePokeOnCommit(serverCtx);

  app.get(
    "/sync/live",
    upgradeWebSocket(() => ({
      // B-713: so retiring this graph can close the socket, hello or not.
      onOpen(_evt, ws) {
        trackGraphSocket(serverCtx.driver, ws);
      },
      onMessage(evt, ws) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(evt.data));
        } catch {
          return; // ignore anything that isn't JSON; poke-only protocol, nothing else to parse
        }
        if (!isHello(parsed)) return;
        const verified = verifyToken(serverCtx.driver, parsed.token);
        if (!verified?.canSync) {
          ws.close(4403, "forbidden");
          return;
        }
        registerLiveConnection(serverCtx, ws, parsed.device_id);
        // B-676: so `token.revoke` can close it, and the poke can re-check the token.
        trackTokenSocket(serverCtx.driver, verified.id, ws);
      },
      onClose(_evt, ws) {
        unregisterLiveConnection(serverCtx, ws);
        untrackTokenSocket(serverCtx.driver, ws);
        untrackGraphSocket(serverCtx.driver, ws);
      },
    })),
  );
}
