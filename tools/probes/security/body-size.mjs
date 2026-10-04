#!/usr/bin/env node
// Does the server bound request bodies? (docs/progress/security-review.md, item 3)
//
// Usage: node tools/probes/security/body-size.mjs http://127.0.0.1:6455 <token> [MB] [server-pid]
// Streams an MB-sized JSON-ish body to an authenticated op and to /sync/push, and reports the
// status plus the server's RSS (from `ps`) before and after when a pid is given.
//
// Result 2026-10-04 at 02fa3dc, 300 MB: both endpoints read the whole body before answering
// (400 after all 300 MB was buffered), server RSS 206 MB -> 1,463 MB. After the
// body-limit commit: 413 `too_large` in ~25 ms, RSS 209 -> 233 MB.

import { execFileSync } from "node:child_process";

const [base, token, mbArg, pid] = process.argv.slice(2);
const MB = Number(mbArg ?? 300);
const rss = () =>
  pid
    ? `${Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", pid]).toString()) / 1024)} MB`
    : "?";

function body() {
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === 0) controller.enqueue(new TextEncoder().encode('{"pad":"'));
      if (sent >= MB) {
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(chunk);
    },
  });
}

for (const path of ["/g/default/api/v1/page.list", "/g/default/sync/push"]) {
  const before = rss();
  const t0 = Date.now();
  let status;
  try {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body(),
      duplex: "half",
    });
    status = `${res.status} ${(await res.text()).slice(0, 80)}`;
  } catch (e) {
    status = `connection error: ${e.cause?.code ?? e.message}`;
  }
  console.log(`${path} ${MB} MB -> ${status} in ${Date.now() - t0} ms; rss ${before} -> ${rss()}`);
}
