#!/usr/bin/env node
// Does revoking a token close the WebSockets it already opened? And does the server ever close a
// WebSocket that never authenticates? (docs/progress/security-review.md, items 2 and 3)
//
// Usage (scratch server only; NOOKLET_DATA must point at that server's data dir):
//   node tools/probes/security/ws-revocation.mjs http://127.0.0.1:6455 <tokenA> <tokenA-id> <tokenB>
// tokenA and tokenB: `nooklet token create --scope write --sync`. The probe revokes A through the
// CLI (a separate process, as an operator would), then writes with B and watches A's socket.
//
// Result 2026-10-04 at 02fa3dc: revoked token's /sync/live socket STAYED OPEN and kept receiving
// pokes; its next HTTP request was 401 at once. An unauthenticated socket that never sends hello
// was still open after the hold period (no server-side handshake timeout).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/server/package.json", import.meta.url));
const WebSocket = require("ws");

const [base, tokenA, tokenAId, tokenB] = process.argv.slice(2);
if (!tokenB) {
  console.error("usage: ws-revocation.mjs <base> <tokenA> <tokenA-id> <tokenB>");
  process.exit(2);
}
const wsBase = base.replace(/^http/, "ws");
const HOLD_MS = Number(process.env.HOLD_MS ?? 12000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + path);
    ws.events = [];
    ws.on("message", (d) => ws.events.push(String(d)));
    ws.on("close", (code) => {
      ws.closedWith = code;
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function write(token, name) {
  const res = await fetch(`${base}/g/default/api/v1/page.create`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.status;
}

// 1. Unauthenticated socket: connect, never say hello.
const silent = await open("/g/default/sync/live");

// 2. Authenticated socket for A.
const a = await open("/g/default/sync/live");
a.send(JSON.stringify({ type: "hello", device_id: "probe-device-a", token: tokenA }));
await sleep(300);

console.log("write with B before revoke:", await write(tokenB, `probe-before-${Date.now()}`));
await sleep(500);
const pokesBefore = a.events.length;

execFileSync("pnpm", ["nooklet", "token", "revoke", tokenAId], { stdio: "ignore" });
console.log("A over HTTP after revoke:", await write(tokenA, `probe-a-${Date.now()}`));

console.log("write with B after revoke:", await write(tokenB, `probe-after-${Date.now()}`));
await sleep(800);
console.log(
  `A's socket after revoke: ${a.closedWith ? `closed ${a.closedWith}` : "OPEN"}; pokes before ${pokesBefore}, after ${a.events.length - pokesBefore}`,
);

await sleep(HOLD_MS);
console.log(
  `unauthenticated socket after ${HOLD_MS} ms: ${silent.closedWith ? `closed ${silent.closedWith}` : "OPEN"}`,
);
silent.close();
a.close();
