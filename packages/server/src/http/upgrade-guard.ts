/**
 * Keeps a client reset during a WebSocket upgrade from crashing the server (B-589) WITHOUT adding a
 * second `'upgrade'` listener, which was the original fix and caused B-602.
 *
 * `@hono/node-server@2.1.1`'s `setupWebSocket()` (its `dist/index.mjs`, behind `serve()`'s
 * `websocket` option) awaits our fetch callback (auth, graph routing/resolution, slow the first time
 * a graph is opened) before calling `wss.handleUpgrade()`, with no `'error'` listener on the raw
 * socket during that wait. A client that resets the TCP connection in that window fires an
 * unhandled `'error'` and takes the whole process down (`tools/probes/upgrade-socket-error.mjs`).
 *
 * B-589 fixed that with a second `server.on("upgrade", ...)` that attached a no-op error listener.
 * But the same hono function rejects a failed upgrade (404 unknown graph, a bare `/sync/live`,
 * `/ui/live` without auth) only `if (server.listenerCount("upgrade") === 1)`. It assumes any other
 * listener will answer the socket. With two listeners nobody did, so every failed upgrade hung with
 * no response until the client gave up (B-602: "NEVER OPENED" after 5 s in
 * `tools/probes/ws-bare-origin.mjs`, and the same for `/g/<unknown>/sync/live`).
 *
 * So the no-op listener goes on at `'connection'` instead, which fires for every TCP socket before
 * any bytes are parsed and therefore before any upgrade. Node's own HTTP server removes only its
 * own `socketOnError` when it hands a socket to `'upgrade'` listeners, so this one stays through the
 * whole handshake. For ordinary HTTP sockets it changes nothing: Node's own error handling still
 * runs alongside it.
 */
import type { ServerType } from "@hono/node-server";

export function guardUpgradeSockets(server: ServerType): void {
  server.on("connection", (socket: NodeJS.EventEmitter) => {
    socket.on("error", () => {});
  });
}
