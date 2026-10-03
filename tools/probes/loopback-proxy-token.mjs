// Does a reverse proxy on the SAME machine as `nooklet serve` make every proxied request look like
// "a loopback caller", and so get the auto-minted write token from `/api/session`?
// (`packages/server/src/http/app.ts#isLoopbackRequest`: peer address is loopback AND the Host
// header is a loopback name.) Behind a same-host proxy the peer is always 127.0.0.1, so the only
// thing left guarding the token is whether the proxy keeps the client's Host.
//
//   node tools/probes/loopback-proxy-token.mjs http://127.0.0.1:6377
//
// Runs a tiny proxy on 127.0.0.1:<random> three ways and asks it for /g/default/api/session:
//   keep-host   — forwards the client's Host (tailscale serve's behaviour, per its source)
//   nginx-default — rewrites Host to the upstream "127.0.0.1:<port>" (what a bare
//                 `proxy_pass http://127.0.0.1:6100;` does), no forwarding headers
//   rewrite+xff — same rewrite, plus X-Forwarded-For (most proxies' usual config)
//
// Results 2026-10-03 (docs/progress/real-device-test.md):
//   before the fix: keep-host → no token (403, Host not allowed); nginx-default → TOKEN HANDED OUT;
//                   rewrite+xff → TOKEN HANDED OUT
//   after `http/app.ts` refuses requests carrying forwarding headers: rewrite+xff → no token;
//                   nginx-default → still TOKEN HANDED OUT (no header distinguishes it from a local
//                   browser; documented as "never configure a same-host proxy that way").
// A Kubernetes ingress proxy runs in a different pod, so its peer address is never loopback.
import http from "node:http";

const upstream = new URL(process.argv[2] ?? "http://127.0.0.1:6100");

function proxy(mode) {
  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (mode !== "keep-host") headers.host = upstream.host;
    if (mode === "rewrite+xff") headers["x-forwarded-for"] = "100.64.0.7";
    const out = http.request(
      { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(out);
  });
}

for (const mode of ["keep-host", "nginx-default", "rewrite+xff"]) {
  const server = proxy(mode);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  // The "remote client": a tailnet device asking for the app by its tailnet name.
  const body = await new Promise((resolve) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: "/g/default/api/session",
          headers: { host: "nooklet.example.ts.net" },
        },
        (r) => {
          let s = "";
          r.on("data", (d) => (s += d));
          r.on("end", () => resolve(`${r.statusCode} ${s.slice(0, 90)}`));
        },
      )
      .on("error", (e) => resolve(`error ${e.message}`));
  });
  const leaked = /"token":"nk_/.test(body);
  console.log(`${mode.padEnd(14)} ${leaked ? "TOKEN HANDED OUT" : "no token"}  ${body}`);
  server.close();
}
