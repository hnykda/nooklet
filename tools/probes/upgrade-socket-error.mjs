// Settles: does @hono/node-server's WebSocket upgrade handling crash the whole process when a
// client resets the TCP connection while our `fetch` callback (auth/graph routing) is still
// pending? (2026-09-16, owner report: `pnpm nooklet serve` crashed moments after opening the
// desktop app — "Error: read ECONNRESET ... Emitted 'error' event on Socket instance").
//
// Answer: YES, without the fix in `packages/server/src/cli.ts`'s `serve` case. Isolated the exact
// pattern @hono/node-server@2.1.1's `setupWebSocket()` uses (`dist/index.mjs`, `server.on(
// "upgrade", async (request, socket, head) => { await fetchCallback(...); wss.handleUpgrade(...) })`
// — no `socket.on("error", ...)` anywhere in that function) in a minimal server with an artificial
// delay standing in for real auth/graph-resolution work, then reset a real TCP connection mid-delay
// via `net.Socket#resetAndDestroy()`. Without a fix: crashes immediately with the EXACT reported
// stack (`Error: read ECONNRESET ... emitErrorCloseNT`). With the fix (a second `'upgrade'`
// listener, registered on the same `http.Server` after `serve()` returns, that attaches
// `socket.on("error", () => {})`): survives — confirmed the listener still attaches before the
// vulnerable gap opens, because Node's `EventEmitter` calls listeners synchronously in registration
// order for one `emit()`, and an async listener only yields control at its first `await`.
//
// UPDATE 2026-10-03 (B-602): the fix as described above (a second `'upgrade'` listener) broke
// failed upgrades — @hono/node-server answers one only when its own listener is the sole one, so
// they hung. The fix now attaches the same no-op listener at `'connection'` instead
// (`packages/server/src/http/upgrade-guard.ts`); `--fix` here still demonstrates the mechanism.
//
// A real client (a page navigating away mid-handshake, a reconnect loop superseding its own
// in-flight attempt) resetting mid-upgrade is ordinary behavior, not misbehavior — this is a real
// crash-the-whole-server bug in a dependency, not something only a malicious client could trigger.
//
// Run from anywhere (resolves `ws` relative to this file, through `packages/server`'s own
// node_modules, since `ws` is not hoisted to the workspace root):
//   node tools/probes/upgrade-socket-error.mjs        (no fix — crashes, exit code 1)
//   node tools/probes/upgrade-socket-error.mjs --fix   (fix applied — survives, exit code 0)
import http from "node:http";
import net from "node:net";
import wsPkg from "../../packages/server/node_modules/ws/index.js";

const { WebSocketServer } = wsPkg;

const FIX = process.argv.includes("--fix");
const port = Number(process.env.PORT ?? 18722);

const server = http.createServer((_req, res) => res.end("ok"));
const wss = new WebSocketServer({ noServer: true });

// The vulnerable pattern itself, standing in for @hono/node-server's `setupWebSocket()`: async
// work (there: `await fetchCallback(...)`, i.e. our own Hono app's auth + graph dispatch) with no
// error listener on `socket` for the whole time it is in flight.
server.on("upgrade", async (request, socket, head) => {
  await new Promise((r) => setTimeout(r, 200));
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

if (FIX) {
  server.on("upgrade", (_request, socket) => {
    socket.on("error", () => {});
  });
}

server.listen(port, "127.0.0.1", () => {
  console.log(`server up on ${port}, FIX=${FIX}`);
  const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
    sock.write(
      "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    // Reset well inside the 200ms async gap — the client side of an abrupt disconnect.
    setTimeout(() => sock.resetAndDestroy(), 30);
  });
  sock.on("error", () => {});

  setTimeout(() => {
    console.log(`server survived 500ms after the reset — no crash (FIX=${FIX})`);
    process.exit(0);
  }, 500);
});
