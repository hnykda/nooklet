/**
 * Probe (2026-10-05, B-738): does a picture shown a SECOND time come from the browser's cache, or
 * is it downloaded again? And how many bytes does a page of photos cost?
 *
 * A real `nooklet serve` (this checkout's server, this checkout's production web build) on a
 * scratch data dir, behind a small counting proxy that also throttles responses to the measured
 * tailnet rate (~1.6 MB/s, B-738). Three generated noise images of ~3.5 MB each (noise so PNG
 * cannot compress them: the size of the owner's photos without using any of them). For each
 * engine (Playwright's Chromium and WebKit) it counts, AT THE SERVER, the requests for each picture:
 *
 *   1. first visit of a page with the three pictures,
 *   2. in-app navigation to another page and Back (the SPA keeps the document),
 *   3. reload,
 *   4. the same page in a second tab of the same browser profile,
 *   5. cross-origin, the Capacitor shape: the page on 127.0.0.1, the picture on `localhost` —
 *      added, removed, added again, then the page reloaded and added again.
 *
 * and how long each step took until every picture had decoded. Prints a table; asserts nothing.
 *
 *   pnpm --filter @nooklet/web build            # the probe serves whatever dist/ holds
 *   node tools/probes/image-cache/probe.mjs     # PORT=6560 RATE=1600000 to change
 *
 * Server-side counting is the ground truth: Playwright's own request events fire for memory-cache
 * hits too in some engines, and `page.route` (which would let us count in the browser) turns
 * Chromium's HTTP cache off altogether.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, webkit } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const PORT = Number(process.env.PORT ?? 6560);
const PROXY = PORT + 1;
const RATE = Number(process.env.RATE ?? 1_600_000); // bytes/s; 0 = unthrottled
const ENGINES = (
  process.env.ENGINES ??
  (process.platform === "darwin" ? "chromium,webkit,wkwebview" : "chromium,webkit")
).split(",");

/** A noise RGB PNG: incompressible, so `w*h*3` bytes on the wire. */
function noisePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0]), randomBytes(width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the counting, throttling proxy -----------------------------------------------------------
/** path → { hits, bytes } for every `/assets/` request that reached the server. */
const hits = new Map();
/** One link shared by every response, as the tailnet is: `linkFreeAt` is when the bytes queued
 * so far will have gone out at RATE. */
let linkFreeAt = 0;
function throttle() {
  if (!RATE) return new Transform({ transform: (c, _e, cb) => cb(null, c) });
  return new Transform({
    transform(chunk, _enc, cb) {
      linkFreeAt = Math.max(linkFreeAt, Date.now()) + (chunk.length / RATE) * 1000;
      setTimeout(() => cb(null, chunk), Math.max(0, linkFreeAt - Date.now()));
    },
  });
}
/**
 * Control pictures served by the proxy itself, one per header set, to tell "this engine has no HTTP
 * cache" from "this engine will not cache THESE responses". `full` is what `/assets/:id` sends.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";
const CONTROLS = {
  "cache-control only": { "cache-control": IMMUTABLE },
  "+ nosniff": { "cache-control": IMMUTABLE, "x-content-type-options": "nosniff" },
  "+ csp sandbox": { "cache-control": IMMUTABLE, "content-security-policy": "sandbox" },
  "full (as /assets/:id)": {
    "cache-control": IMMUTABLE,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  },
  "+ etag, last-modified": {
    "cache-control": IMMUTABLE,
    etag: '"ctl-1"',
    "last-modified": "Mon, 05 Oct 2026 00:00:00 GMT",
  },
  "no cache-control": {},
};
const controlPng = noisePng(64, 64);
/** Set once the uploads exist: the app's first asset URL, shown on the control page too. */
let controlExtra = "";
/** control name → requests that reached the proxy. */
const controlHits = new Map();
function serveControl(url, res) {
  if (url.pathname === "/ctl/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><body>${Object.keys(CONTROLS)
        .map((_k, i) => `<img class="vr-image ctl" src="/ctl/img/${i}.png">`)
        .join("")}${
        // The app's own first picture, from a page with no service worker and no app around it.
        controlExtra ? `<img class="vr-image" src="${controlExtra}" style="width:200px">` : ""
      }</body>`,
    );
    return;
  }
  const i = Number(url.pathname.match(/\/ctl\/img\/(\d+)\.png$/)?.[1]);
  const name = Object.keys(CONTROLS)[i];
  controlHits.set(name, (controlHits.get(name) ?? 0) + 1);
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": controlPng.length,
    ...CONTROLS[name],
  });
  res.end(controlPng);
}

function proxyHandler(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/ctl/")) return serveControl(url, res);
  const isAsset = /\/assets\//.test(url.pathname);
  const up = http.request(
    { host: "127.0.0.1", port: PORT, path: req.url, method: req.method, headers: req.headers },
    (r) => {
      if (isAsset) {
        const key = url.pathname + url.search;
        const h = hits.get(key) ?? { hits: 0, bytes: 0, statuses: [] };
        h.hits++;
        h.statuses.push(`${req.method} ${r.statusCode}`);
        h.bytes += Number(r.headers["content-length"] ?? 0);
        hits.set(key, h);
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      (isAsset ? r.pipe(throttle()) : r).pipe(res);
    },
  );
  up.on("error", () => res.destroy());
  req.pipe(up);
}
const proxy = http.createServer(proxyHandler);

function snapshot() {
  let n = 0;
  let bytes = 0;
  for (const h of hits.values()) {
    n += h.hits;
    bytes += h.bytes;
  }
  for (const c of controlHits.values()) n += c;
  return { n, bytes, controls: new Map(controlHits) };
}

/** Which control pictures were fetched between two snapshots. */
function controlsBetween(before, after) {
  const fetched = [...after.controls]
    .filter(([k, v]) => v > (before.controls.get(k) ?? 0))
    .map(([k]) => k);
  return fetched.length === 0 ? "" : fetched.join("; ");
}

// ---- the server --------------------------------------------------------------------------------
async function waitFor(url) {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no answer from ${url}`);
}

const dataDir = mkdtempSync(join(tmpdir(), "nooklet-image-cache-"));
const server = spawn(
  "pnpm",
  [
    "--filter",
    "@nooklet/server",
    "exec",
    "tsx",
    "src/cli.ts",
    "serve",
    "--data",
    dataDir,
    "--port",
    String(PORT),
    "--allow-host",
    "localhost,127.0.0.1",
  ],
  { cwd: repoRoot, stdio: "ignore", detached: true },
);
const cleanup = () => {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  proxy.close();
  tlsProxy?.close();
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("exit", cleanup);

await waitFor(`http://127.0.0.1:${PORT}/healthz`);
await new Promise((r) => proxy.listen(PROXY, "127.0.0.1", r));
// The phone reaches its server over https (a tailnet name), and a `capacitor://` page may not
// load an http picture at all (mixed content), so the Capacitor shape needs TLS: the same proxy
// on PROXY+1 with a throwaway self-signed certificate the probe's WKWebView is told to accept.
let tlsProxy;
const TLS_PORT = PROXY + 1;
if (ENGINES.includes("wkwebview")) {
  const key = join(dataDir, "probe-key.pem");
  const cert = join(dataDir, "probe-cert.pem");
  const r = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  tlsProxy = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, proxyHandler);
  tlsProxy.on("tlsClientError", (e) => console.log(`  [tls] client error: ${e.message}`));
  await new Promise((ok) => tlsProxy.listen(TLS_PORT, "127.0.0.1", ok));
}
const base = `http://127.0.0.1:${PROXY}`;
const { token } = await (await fetch(`http://127.0.0.1:${PORT}/api/session`)).json();
async function op(name, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} ${res.status} ${await res.text()}`);
  return res.json();
}

const uploads = [];
for (let i = 0; i < 3; i++) {
  const side = Number(process.env.SIDE ?? 1100);
  const png = noisePng(side, side - 50 + i * 10);
  uploads.push(
    await op("asset.upload", {
      filename: `noise-${i}.png`,
      mime_type: "image/png",
      data_base64: png.toString("base64"),
    }),
  );
}
const imageBytes = uploads.reduce((s, u) => s + (u.byte_size ?? 0), 0);
await op("page.create", { name: "Elsewhere", markdown: "- nothing to see" });
await op("page.create", {
  name: "Photos",
  markdown: ["- [[Elsewhere]]", ...uploads.map((u) => `- ${u.markdown}`)].join("\n"),
});
const assetPath = uploads[0].markdown.match(/\((assets\/[^)]+)\)/)[1];
controlExtra = `/g/default/${assetPath}`;

// ---- the measurement ---------------------------------------------------------------------------
async function allDecoded(page) {
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll("img.vr-image")];
      return imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    },
    undefined,
    { timeout: 120_000 },
  );
}

async function step(label, rows, fn) {
  const before = snapshot();
  const t0 = Date.now();
  await fn();
  const after = snapshot();
  rows.push({
    step: label,
    requests: after.n - before.n,
    MB: ((after.bytes - before.bytes) / 1e6).toFixed(1),
    ms: Date.now() - t0,
  });
}

const results = {};
/** The real WKWebView (`./wkwebview.swift`), steps driven there, requests counted here. */
async function wkwebview(mode, store, rows) {
  const origin = mode.includes("capacitor") ? `https://127.0.0.1:${TLS_PORT}` : base;
  const urls = uploads.map(
    (u) => `${origin}/g/default/${u.markdown.match(/\((assets\/[^)]+)\)/)[1]}`,
  );
  const child = spawn(wkBin, [mode, base, store, ...urls], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const open = new Map();
  for await (const line of createInterface({ input: child.stdout })) {
    const [kind, ...rest] = line.split(" ");
    if (kind === "BEGIN") open.set(rest.join(" "), snapshot());
    else if (kind === "END") {
      const ms = Number(rest.pop());
      const label = rest.join(" ");
      const before = open.get(label);
      const after = snapshot();
      rows.push({
        step: label,
        requests: after.n - before.n,
        MB: ((after.bytes - before.bytes) / 1e6).toFixed(1),
        ms,
        "control pictures fetched": controlsBetween(before, after),
      });
    } else if (kind !== "DONE") console.log(`  [${mode}] ${line}`);
  }
}
const wkBin = join(dataDir, "wk-image-cache");
if (ENGINES.includes("wkwebview")) {
  const r = spawnSync(
    "swiftc",
    ["-O", fileURLToPath(new URL("./wkwebview.swift", import.meta.url)), "-o", wkBin],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("swiftc failed");
}

for (const name of ENGINES) {
  if (name === "wkwebview") {
    const rows = [];
    const desktopStore = randomUUID();
    await wkwebview("desktop", desktopStore, rows);
    await wkwebview("relaunch-desktop", desktopStore, rows);
    const noSwStore = randomUUID();
    rows.push({ step: "--- the same, service worker API removed ---" });
    await wkwebview("desktop-nosw", noSwStore, rows);
    await wkwebview("relaunch-desktop-nosw", noSwStore, rows);
    const ctlStore = randomUUID();
    await wkwebview("control", ctlStore, rows);
    await wkwebview("relaunch-control", ctlStore, rows);
    const capStore = randomUUID();
    await wkwebview("capacitor", capStore, rows);
    await wkwebview("relaunch-capacitor", capStore, rows);
    results[name] = rows;
    continue;
  }
  const engine = { chromium, webkit }[name];
  const browser = await engine.launch();
  // Tall enough that all three pictures are in view: `loading="lazy"` is not what is measured.
  const context = await browser.newContext({ viewport: { width: 1280, height: 4000 } });
  const page = await context.newPage();
  const swHits = [];
  page.on("response", (r) => {
    if (r.url().includes("/assets/") && r.fromServiceWorker()) swHits.push(r.url());
  });
  const rows = [];
  await step("1 first visit", rows, async () => {
    await page.goto(`${base}/page/Photos`);
    await allDecoded(page);
  });
  await step("2 in-app away and Back", rows, async () => {
    await page.locator(".vr-outliner a", { hasText: "Elsewhere" }).first().click();
    await page.waitForURL(/Elsewhere/);
    await page.locator(".vr-row", { hasText: "nothing to see" }).first().waitFor();
    await page.goBack();
    await allDecoded(page);
  });
  await step("3 reload", rows, async () => {
    await page.reload();
    await allDecoded(page);
  });
  await step("4 second tab, same profile", rows, async () => {
    const tab = await context.newPage();
    await tab.goto(`${base}/page/Photos`);
    await allDecoded(tab);
    await tab.close();
  });
  const cross = `http://localhost:${PROXY}/${assetPath}`;
  const addImg = (p) =>
    p.evaluate(
      (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            img.remove();
            resolve(undefined);
          };
          img.onerror = reject;
          img.src = src;
          document.body.append(img);
        }),
      cross,
    );
  await step("5a cross-origin, first", rows, () => addImg(page));
  await step("5b cross-origin, again", rows, () => addImg(page));
  await step("5c cross-origin, after reload", rows, async () => {
    await page.reload();
    await allDecoded(page);
    await addImg(page);
  });
  rows.push({ step: "served by the service worker", requests: swHits.length, MB: "", ms: "" });
  results[name] = rows;
  await browser.close();
}

console.log(
  `\n3 images, ${(imageBytes / 1e6).toFixed(1)} MB in all, throttled to ${
    RATE ? `${(RATE / 1e6).toFixed(1)} MB/s` : "nothing"
  }`,
);
for (const [name, rows] of Object.entries(results)) {
  console.log(`\n${name}`);
  console.table(rows);
}
console.log(
  "\ncontrol pictures, requests per picture over all control steps:",
  Object.fromEntries(controlHits),
);
console.log(
  "\nper URL:",
  Object.fromEntries([...hits].map(([k, v]) => [k, v.statuses.join(", ")])),
);
cleanup();
process.exit(0);
