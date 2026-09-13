// Settles: how long is the window in which a local edit sits in the DB worker's message queue —
// handed to `applyOps`, not yet durable — so that a reload loses it (B-247)?
// (2026-09-13, Chromium via @playwright/test 1.63, copy of the real graph: 952 pages, 18.6k blocks)
//
// Method. An edit is lost on reload exactly when the worker is still busy with an earlier task when
// the page unloads, so the window is the worker's event-loop lag. A heartbeat installed inside the
// worker (a 10 ms `setTimeout` chain) records every gap longer than 50 ms; a gap is time during
// which a queued `applyLocalOps` message could not run. Measured in four phases:
//
//   cold   — first load in a fresh browser context: empty OPFS, full bootstrap from the server
//   warm   — reload of the same context: replica already on disk
//   typing — plain typing into a block of a big page, 60 ms between keys
//   link   — typing `[[` and a query, which runs the popup's block search in the worker
//
// Caveat: the heartbeat is installed from `page.on("worker")`, so whatever the worker does before
// that evaluate lands (module import, wasm compile) is not seen; the cold/warm numbers are a floor.
//
// Also measured end to end (the thing that matters): type, wait N ms, reload, ask the server
// whether the text arrived — for N in DELAYS, on the warm page, with no artificial load.
//
// Run from `e2e/` (so `@playwright/test` resolves) against a running nooklet server:
//   BASE=http://127.0.0.1:16402 PAGE="<a big page>" node ../tools/probes/replica-busy-window.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6188";
const BIG_PAGE = process.env.PAGE;
const DELAYS = (process.env.DELAYS ?? "0,100,300,700,1500").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await (await fetch(`${BASE}/api/session`)).json();
async function api(op, body) {
  const res = await fetch(`${BASE}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const HEARTBEAT = () => {
  if (globalThis.__lag) return;
  const lag = { gaps: [], started: Date.now() };
  globalThis.__lag = lag;
  let last = Date.now();
  const tick = () => {
    const now = Date.now();
    if (now - last > 50) lag.gaps.push([last - lag.started, now - last]);
    last = now;
    setTimeout(tick, 10);
  };
  setTimeout(tick, 10);
};

function summarize(label, lag, fromMs = 0) {
  const gaps = lag.gaps.filter(([at]) => at >= fromMs);
  const total = gaps.reduce((s, [, d]) => s + d, 0);
  const max = gaps.reduce((m, [, d]) => Math.max(m, d), 0);
  console.log(
    `${label}: ${gaps.length} gaps > 50 ms, longest ${max} ms, total ${total} ms`,
    JSON.stringify(gaps.slice(0, 12)),
  );
}

async function dbWorker(page) {
  for (let i = 0; i < 200; i++) {
    const w = page.workers().find((x) => x.url().includes("db.worker"));
    if (w) return w;
    await sleep(25);
  }
  throw new Error("no db worker");
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on("worker", (w) => {
  if (w.url().includes("db.worker")) void w.evaluate(HEARTBEAT).catch(() => {});
});

// cold
let t0 = Date.now();
await page.goto(`${BASE}/journals`);
await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
console.log(`cold: first row after ${Date.now() - t0} ms`);
await sleep(6000);
summarize("cold", await (await dbWorker(page)).evaluate(() => globalThis.__lag));

// warm
t0 = Date.now();
await page.reload();
await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
console.log(`warm: first row after ${Date.now() - t0} ms`);
await sleep(6000);
summarize("warm", await (await dbWorker(page)).evaluate(() => globalThis.__lag));

if (BIG_PAGE) {
  await page.goto(`${BASE}/page/${encodeURIComponent(BIG_PAGE)}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
  await sleep(4000);
  const w = await dbWorker(page);
  const since = await w.evaluate(() => Date.now() - globalThis.__lag.started);
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("End");
  await page.keyboard.type(" probe typing words", { delay: 60 });
  await sleep(1500);
  summarize("typing", await w.evaluate(() => globalThis.__lag), since);
  const since2 = await w.evaluate(() => Date.now() - globalThis.__lag.started);
  await page.keyboard.type(" [[proj", { delay: 60 });
  await sleep(1500);
  summarize("link", await w.evaluate(() => globalThis.__lag), since2);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

// end to end, warm page, no artificial load. Two questions per delay, because they differ:
//   local  — what the reloaded page shows, i.e. what the replica holds (did the op become durable?)
//   server — what the server holds 3 s later (was it pushed?)
// then ONE unrelated edit on another page (a local write schedules a push of the whole outbox),
// and the server is asked again.
const stamp = Date.now().toString(36);
const names = [];
for (const delay of DELAYS) {
  const name = `Probe BusyWindow ${stamp} ${delay}`;
  names.push(name);
  await api("page.create", { name, markdown: "- x" });
  await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept", { delay: 20 });
  await sleep(delay);
  await page.reload();
  const row = page.locator(".vr-outliner .vr-row").first();
  await row.waitFor();
  await sleep(3000);
  const local = await row.textContent();
  const server = (await api("page.read", { page: name, format: "json" })).tree.map(
    (n) => n.content,
  );
  console.log(
    `reload ${delay} ms after typing: local ${JSON.stringify(local)}, server ${JSON.stringify(server)}`,
  );
}
const nudge = `Probe BusyWindow ${stamp} nudge`;
await api("page.create", { name: nudge, markdown: "- n" });
await page.goto(`${BASE}/page/${encodeURIComponent(nudge)}`);
await page.locator(".vr-outliner .vr-block-view").first().click();
await page.locator(".cm-content").waitFor();
await page.keyboard.press("End");
await page.keyboard.type("udge", { delay: 20 });
await sleep(4000);
for (const name of names) {
  const server = (await api("page.read", { page: name, format: "json" })).tree.map(
    (n) => n.content,
  );
  console.log(
    `after one more local edit elsewhere: ${name.split(" ").pop()} ms -> server ${JSON.stringify(server)}`,
  );
}
await browser.close();
