/**
 * Probe (B-500, B-511), the journals view: does a refresh flash or rebuild anything on the owner's
 * main screen? `refresh-render-count.mjs` covers pages; this opens `/journals` on a copy of the real
 * graph, writes one block in the first real day N times through the API (a pull each time), and
 * records every DOM change: which regions (day titles, each row but the written one, the agenda,
 * the sidebar) ever showed a second text, and how many rows, ref labels, date chips, property rows
 * and agenda items were created. Written 2026-09-13 (ref-label-flash).
 *
 * Usage (never ~/.nooklet/default, never port 6100):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   NOOKLET_DATA=<scratch> pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6417 --no-mirror
 *   URL=http://127.0.0.1:6417 node tools/probes/refresh-journals-flash.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium, webkit } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6417";
const N = Number(process.env.N ?? 5);
const engine = process.env.ENGINE === "webkit" ? webkit : chromium;

async function api(page, op, body) {
  return page.evaluate(
    async ([op, body]) => {
      const { token } = await (await fetch("/api/session")).json();
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${JSON.stringify(json)}`);
      return json;
    },
    [op, body],
  );
}

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

const browser = await engine.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
const page = await context.newPage();
await page.goto(`${base}/journals`);
await page.locator(".journal-day .vr-outliner .vr-row").first().waitFor({ timeout: 180_000 });
if ((await page.locator(".app-sidebar").count()) === 0) {
  await page.locator("button[aria-label='Toggle sidebar']").click();
}
await page.waitForTimeout(4000);

// The first real day's rows, and one of them with plain one-line text to write to.
const candidates = await page
  .locator(".journal-day .vr-outliner")
  .first()
  .locator(".vr-row")
  .evaluateAll((els) => els.map((e) => e.dataset.blockId));
let target;
for (const id of candidates.reverse()) {
  const { page: pageName } = await api(page, "block.read", { id, depth: 0 });
  const tree = flatten((await api(page, "page.read", { page: pageName, format: "json" })).tree);
  const b = tree.find((n) => n.id === id);
  if (b?.content && !b.content.includes("\n") && b.content.length < 200) {
    target = b;
    break;
  }
}
if (!target) throw new Error("no plain block in the first journal day");
const plain = target.content.replace(/ ·$/, "");
let text = target.content;
if (text !== plain) {
  await api(page, "block.update", { id: target.id, old_str: text, new_str: plain });
  text = plain;
  await page.waitForTimeout(2000);
}

await page.evaluate((skip) => {
  const regions = {
    dayTitles: ".journal-day-title",
    agenda: ".journal-agenda",
    sidebar: ".app-sidebar",
    wordCount: '[data-status-item="word-count"]',
  };
  const mounts = {
    rows: ".journal-stream .vr-row",
    blockRefs: ".journal-stream .vr-block-ref",
    dateChips: ".journal-stream .vr-date",
    propRows: ".journal-stream .vr-prop",
    agendaItems: ".journal-agenda-item",
    embedItems: ".journal-stream .vr-embed-item",
    queryHits: ".journal-stream .vr-query-hit",
    sidebarItems: ".app-sidebar li",
  };
  const out = { seq: {}, rows: {}, written: [], mounts: {}, callbacks: 0, rowCount: 0 };
  for (const sel of Object.values(mounts))
    for (const el of document.querySelectorAll(sel)) el.dataset.probeSeen = "1";
  const push = (map, key, value) => {
    const list = map[key] ?? [];
    map[key] = list;
    if (list[list.length - 1] !== value) list.push(value);
  };
  const take = () => {
    out.callbacks++;
    for (const [name, sel] of Object.entries(regions))
      push(
        out.seq,
        name,
        [...document.querySelectorAll(sel)].map((e) => e.textContent ?? "").join(" | "),
      );
    const rows = document.querySelectorAll(".journal-stream .vr-row");
    out.rowCount = rows.length;
    for (const row of rows) {
      const shown = row.querySelector(".vr-block-view")?.textContent ?? "";
      // The written row changes on purpose; its texts are kept apart, to see what it passed through.
      if (row.dataset.blockId === skip) {
        if (out.written[out.written.length - 1] !== shown) out.written.push(shown);
        continue;
      }
      push(out.rows, row.dataset.blockId, shown);
    }
    for (const [name, sel] of Object.entries(mounts))
      for (const el of document.querySelectorAll(`${sel}:not([data-probe-seen])`)) {
        el.dataset.probeSeen = "1";
        out.mounts[name] = (out.mounts[name] ?? 0) + 1;
      }
  };
  take();
  new MutationObserver(take).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  window.__probe = out;
}, target.id);

for (let i = 0; i < N; i++) {
  const next = i % 2 === 0 ? `${plain} ·` : plain;
  await api(page, "block.update", { id: target.id, old_str: text, new_str: next });
  text = next;
  await page.waitForTimeout(1500);
}
const r = await page.evaluate(() => window.__probe);
console.log(
  JSON.stringify(
    {
      engine: engine === chromium ? "chromium" : "webkit",
      written: { id: target.id, content: plain },
      rowsOnScreen: r.rowCount,
      refreshes: N,
      callbacks: r.callbacks,
      writtenRowShowed: r.written,
      regionsThatChanged: Object.fromEntries(
        [...Object.entries(r.seq), ...Object.entries(r.rows)].filter(([, s]) => s.length > 1),
      ),
      mounts: r.mounts,
    },
    null,
    1,
  ),
);
await browser.close();
