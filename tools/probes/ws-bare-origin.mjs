// Does a WebSocket to a server's BARE origin (`/sync/live`, no `/g/<id>` prefix) work the way the
// HTTP 307-to-`/g/default` fallback makes plain requests work? Settles whether a client may store a
// bare `http://host:port` as its graph base URL. Uses Node's built-in (browser-shaped) WebSocket.
//
//   node tools/probes/ws-bare-origin.mjs http://192.168.1.5:6311
//
// Result 2026-10-03 against `nooklet serve`: `/g/default/sync/live` OPENs; bare `/sync/live`
// never opens (hangs or errors) — a WebSocket does not follow redirects — so a bare base URL means
// live sync silently never connects. Hence `apps/web/src/data/connect-graph.ts#graphBaseUrl`.
const base = (process.argv[2] ?? "http://127.0.0.1:6100").replace(/^http/, "ws");
let pending = 2;
for (const path of ["/sync/live", "/g/default/sync/live"]) {
  const ws = new WebSocket(base + path);
  const done = (msg) => {
    clearTimeout(timer);
    console.log(path, msg);
    if (--pending === 0) process.exit(0);
  };
  const timer = setTimeout(() => {
    done("NEVER OPENED (no open within 5s)");
    ws.close();
  }, 5000);
  ws.onopen = () => {
    done("OPEN");
    ws.close();
  };
  ws.onerror = () => done("error event (did not open)");
}
