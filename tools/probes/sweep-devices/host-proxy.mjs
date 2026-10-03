// A tiny reverse proxy that makes a browser on this Mac look like a REMOTE device to nooklet,
// while keeping a secure context (127.0.0.1 is one; a plain-http LAN IP is not — B-27).
//
//   node host-proxy.mjs <listenPort> <upstreamPort> [fakeHost] [staticDir]
//
// With `staticDir`, every path outside /g/, /graphs and /healthz is served from that directory
// instead (index.html for anything without an extension) — a same-origin stand-in for a
// Capacitor shell, whose bundled app lives at `capacitor://localhost` while the server is
// elsewhere. Same-origin on purpose: it isolates the app-side flow from CORS, which is a separate
// question (see the review doc).
//
// Rewrites `Host` to `fakeHost` (default "nooklet.sweep.test") so the server's
// `isLoopbackRequest` (peer AND Host must be loopback) says no and injects no token — the same
// thing a TLS-terminating reverse proxy (Caddy, `tailscale serve`) in front of the server does.
// Handles WebSocket upgrades (sync/live, ui/live). Stand-in for the deployment, not a model of it.
import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const [listenPort, upstreamPort, fakeHost = "nooklet.sweep.test", staticDir] = process.argv.slice(2);
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res) {
  if (!staticDir) return false;
  const path = new URL(req.url, "http://x").pathname;
  if (/^\/(g\/|graphs|healthz)/.test(path)) return false;
  let file = join(staticDir, path);
  if (!extname(path) || !existsSync(file)) file = join(staticDir, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}
const UP = Number(upstreamPort);

const server = http.createServer((req, res) => {
  if (serveStatic(req, res)) return;
  const up = http.request(
    {
      host: "127.0.0.1",
      port: UP,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: fakeHost },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream down");
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const up = net.connect(UP, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? fakeHost : req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(Number(listenPort), "127.0.0.1", () =>
  console.log(`proxy 127.0.0.1:${listenPort} -> 127.0.0.1:${UP} (Host: ${fakeHost})`),
);
