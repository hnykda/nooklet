#!/usr/bin/env node
// Are the live-socket limits (B-676 H4/H12) in force on a real `nooklet serve`, flags included?
//
// Usage (scratch server only):
//   nooklet serve --port 6525 --ws-max-per-token 3
//   node tools/probes/security/ws-limits.mjs http://127.0.0.1:6525 <sync token> [per-token cap]
// The token: `nooklet token create --scope write --sync`. Prints what each socket was closed with.
//
// Result 2026-10-04 (ws-hardening branch), server started with --ws-max-per-token 3:
//   hello timeout: closed 4408 after ~10.0 s; 4th socket for one token: 4429; 600 KiB frame after
//   hello: 1009; 20 KiB frame before hello: 1009; a 400 KiB frame after hello: stays open.

import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/server/package.json", import.meta.url));
const WebSocket = require("ws");

const [base, token, capArg] = process.argv.slice(2);
if (!token) {
  console.error("usage: ws-limits.mjs <base> <sync token> [per-token cap, default 20]");
  process.exit(2);
}
const cap = Number(capArg ?? 20);
const wsBase = `${base.replace(/^http/, "ws")}/g/default`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(path = "/sync/live") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + path);
    ws.closed = new Promise((r) =>
      ws.on("close", (code) => {
        ws.code = code;
        r(code);
      }),
    );
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
const hello = (ws) => ws.send(JSON.stringify({ type: "hello", device_id: "probe", token }));

// 1. Hello timeout.
const silent = await open();
const t0 = Date.now();
const code = await silent.closed;
console.log(`hello timeout: closed ${code} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// 2. Per-token cap.
const held = [];
for (let i = 0; i < cap; i++) {
  const ws = await open(i % 2 ? "/ui/live" : "/sync/live");
  if (i % 2) {
    ws.send(
      JSON.stringify({
        type: "hello",
        device_id: "probe",
        window_id: `w${i}`,
        token,
        control_enabled: false,
      }),
    );
  } else hello(ws);
  held.push(ws);
  await sleep(30);
}
const over = await open();
hello(over);
console.log(`socket ${cap + 1} for one token: closed ${await over.closed}`);
console.log(`the first ${cap}: ${held.filter((w) => w.code === undefined).length} still open`);
for (const ws of held) ws.close();
await sleep(200);

// 3. Frame limits.
const fine = await open();
hello(fine);
await sleep(50);
fine.send("x".repeat(400 * 1024));
const big = await open();
hello(big);
await sleep(50);
big.send("x".repeat(600 * 1024));
console.log(`600 KiB frame after hello: closed ${await big.closed}`);
const early = await open();
early.send("x".repeat(20 * 1024));
console.log(`20 KiB frame before hello: closed ${await early.closed}`);
await sleep(200);
console.log(
  `400 KiB frame after hello: ${fine.code === undefined ? "still open" : `closed ${fine.code}`}`,
);
fine.close();
