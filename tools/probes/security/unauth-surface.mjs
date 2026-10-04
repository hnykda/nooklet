#!/usr/bin/env node
// What does a nooklet server answer to someone with NO credential? (docs/progress/security-review.md)
//
// Usage: node tools/probes/security/unauth-surface.mjs http://127.0.0.1:6455 [host-header]
// Run against a scratch server only (`NOOKLET_DATA=$(mktemp -d) pnpm nooklet serve --port 6455 ...`).
// Sends every known route without Authorization and prints status, the security headers, and the
// first bytes of the body. A row that answers 2xx and is not on the public list in
// docs/spec/security-inventory.md is a finding.
//
// Result 2026-10-04 at 02fa3dc (before the hardening commits): every /api/v1, /sync, /mcp, /graphs
// route 401; public: /healthz, /api/session (graphId, journal format, task workflow, no token for a
// non-loopback peer), /openapi.json (full op list), /assets/:id, /plugins/:id/client.<hash>.js, the
// SPA shell, /sw.js. No CSP / X-Frame-Options / Referrer-Policy / HSTS on any response.
// With `--host 0.0.0.0` and Host "evil.example": every /g/default route 403 EXCEPT
// /g/default/plugins/... (200, the shell via notFound): routes mounted before createApp's Host
// guard skipped it. Unknown graph id: 404 (vs 403/401), so graph ids are enumerable.
// After the hardening commits: nosniff/DENY/no-referrer everywhere, CSP on the shell,
// /plugins/... 403 for a foreign Host, /api/session `loopback_token_disabled` on a 0.0.0.0 bind.

import { request } from "node:http";

const base = process.argv[2] ?? "http://127.0.0.1:6455";
const host = process.argv[3];
const headers = host ? { host } : {};

const probes = [
  ["GET", "/healthz"],
  ["GET", "/graphs"],
  ["POST", "/graphs"],
  ["GET", "/"],
  ["GET", "/sw.js"],
  ["GET", "/manifest.webmanifest"],
  ["GET", "/g/default/"],
  ["GET", "/g/default/healthz"],
  ["GET", "/g/default/api/session"],
  ["GET", "/g/default/openapi.json"],
  ["POST", "/g/default/api/v1/page.list"],
  ["GET", "/g/default/api/v1/plugins"],
  ["GET", "/g/default/sync/pull?since=0"],
  ["GET", "/g/default/sync/snapshot"],
  ["POST", "/g/default/sync/push"],
  ["POST", "/g/default/mcp"],
  ["GET", "/g/default/assets/doesnotexist"],
  ["GET", "/g/default/plugins/word-count/client.x.js"],
  ["GET", "/g/nosuchgraph/healthz"],
  ["GET", "/g/default/page/Some%20Page"],
];

const interesting = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "strict-transport-security",
  "access-control-allow-origin",
];

// node:http, not fetch: fetch silently drops a custom `Host`, which is the whole point of arg 2.
function send(method, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      base + path,
      {
        method,
        headers: {
          ...headers,
          accept: "text/html,application/json",
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data }));
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

for (const [method, path] of probes) {
  const res = await send(method, path);
  const body = res.data.replace(/\s+/g, " ").slice(0, 110);
  const sec = interesting
    .filter((h) => res.headers[h] !== undefined)
    .map((h) => `${h}=${String(res.headers[h]).slice(0, 40)}`)
    .join(" ");
  console.log(
    `${res.status} ${method} ${path}\n    ${sec || "(no security headers)"}\n    ${body}`,
  );
}
