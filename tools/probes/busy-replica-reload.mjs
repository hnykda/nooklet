// Settles: is an edit lost when the page reloads while the replica worker is too busy to have
// applied it yet? (2026-09-13, Chromium via @playwright/test 1.63, real-graph copy: 952 pages)
//
// Answer: YES (docs/bugs-inbox/qafix-editor.md B-247). Worker kept busy for 4 s, ` queued` typed,
// reload 1.2 s later (past the editor's 500 ms text debounce): the server has `x`. Reload after
// the busy period instead: `x queued`. Plain typing with an idle worker and a reload 1.9 s later:
// nothing lost, 5 out of 5.
//
// The busy worker is simulated with a synchronous loop evaluated inside it, which is what a long
// SQLite call (a cold bootstrap, a LIKE over every block) looks like from the outside.
//
// Run from `e2e/` (so `@playwright/test` resolves) against a running nooklet server:
//   BASE=http://127.0.0.1:6188 BUSY=4000 node ../tools/probes/busy-replica-reload.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6188";
const BUSY = Number(process.env.BUSY ?? 4000);
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
const stored = async (name) =>
  (await api("page.read", { page: name, format: "json" })).tree.map((n) => n.content);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const stamp = Date.now().toString(36);
const names = [];
for (const [label, reloadAfterMs] of [
  ["reload while busy", 1200],
  ["reload after busy", BUSY + 1500],
]) {
  const name = `Probe BusyReload ${stamp} ${label}`;
  names.push(name);
  await api("page.create", { name, markdown: "- x" });
  await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
  await page.locator(".vr-outliner .vr-row .vr-block-view").first().click();
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("End");
  await sleep(1500); // let the first load's own work finish
  const worker = page.workers().find((w) => w.url().includes("db.worker"));
  if (!worker) throw new Error("no db worker");
  void worker
    .evaluate((ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // busy
      }
    }, BUSY)
    .catch(() => {});
  await page.keyboard.type(" queued", { delay: 20 });
  await sleep(reloadAfterMs);
  await page.reload();
  await page.locator(".vr-outliner .vr-row").first().waitFor();
}
await sleep(8000); // anything that survived has long been pushed by now
for (const name of names) console.log(name, JSON.stringify(await stored(name)));
await browser.close();
