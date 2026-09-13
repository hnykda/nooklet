/**
 * A TCP pass-through that logs every HTTP request line it forwards — used to see what a webview
 * actually fetches from the server, which is the only view into a release build of the desktop app
 * (no devtools). Written for the desktop-shell update probe (`desktop-sw-update.md` beside this
 * file): a request for `/static/index-<hash>.js` that never arrives means the client came out of a
 * service worker's precache, not off the server.
 *
 *   node tools/probes/logging-proxy.mjs <listen-port> <target-port> [log-file]
 *
 * Deliberately byte-level, not an HTTP proxy: the sync WebSocket upgrades on the same connection
 * and must pass through untouched, and the server decides what a client is trusted with from the
 * peer address — which stays 127.0.0.1 either way. A request line is recognised at the start of a
 * client chunk; that misses a pipelined second request inside one chunk, which browsers do not send.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

const [listenPort, targetPort, logFile] = process.argv.slice(2);
if (!listenPort || !targetPort) {
  console.error("usage: logging-proxy.mjs <listen-port> <target-port> [log-file]");
  process.exit(2);
}

const REQUEST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+) HTTP\/1\.[01]\r\n/;
let connections = 0;

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (logFile) appendFileSync(logFile, `${stamped}\n`);
}

net
  .createServer((client) => {
    const id = ++connections;
    const upstream = net.connect(Number(targetPort), "127.0.0.1");
    let upgraded = false;
    client.on("data", (chunk) => {
      if (!upgraded) {
        const head = chunk.subarray(0, 2048).toString("latin1");
        const m = REQUEST_LINE.exec(head);
        if (m) {
          // `sec-fetch-dest` separates what the PAGE asked for (document, script, style) from what
          // a service worker fetched to fill its precache (empty) — the whole point of this log.
          const dest = /\r\nsec-fetch-dest: ([a-z-]+)\r\n/i.exec(head)?.[1] ?? "-";
          log(`#${id} ${m[1]} ${m[2]} dest=${dest}`);
          if (/\r\nupgrade: websocket\r\n/i.test(head)) upgraded = true;
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => client.write(chunk));
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(Number(listenPort), "127.0.0.1", () =>
    log(`proxy 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`),
  );
