/**
 * Probe (B-325, B-326 — verification of `m9/render-views`): on a COPY of the owner's real graph,
 *
 * - B-325: click the empty line of a real multi-line block (default: the journal 2022-12-02 block
 *   whose first line is three emoji — surrogate pairs, so UTF-16 offsets differ from characters),
 *   type a marker, and read the stored text back: the marker must sit on the empty line.
 * - B-326: open a page that does not exist (default `book`), scroll its references, create an
 *   unrelated page through the API, and report whether the panel element, the scroll position and
 *   the absence of "Loading references…" survived.
 *
 * Writes to the graph it is pointed at — only ever a copy:
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6404
 *   URL=http://127.0.0.1:6404 node tools/probes/render-views-blank-line-real-graph.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6404";
const blockPage = process.env.BLOCK_PAGE ?? "2022-12-02";
const blockId = process.env.BLOCK_ID ?? "1m287mdbejacmc";
const missing = process.env.MISSING ?? "book";

async function api(page, op, body) {
  return page.evaluate(
    async ([op, body]) => {
      const { token } = await (await fetch("/api/session")).json();
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    [op, body],
  );
}

async function storedContent(page, id) {
  const out = await api(page, "block.read", { id, format: "json", depth: 0 });
  return out.block.content;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// --- B-325 -----------------------------------------------------------------------------------
await page.goto(`${base}/page/${encodeURIComponent(blockPage)}`);
const row = page.locator(`.vr-row[data-block-id="${blockId}"]`);
await row.waitFor({ timeout: 30_000 });
const before = await storedContent(page, blockId);
const view = row.locator(".vr-block-view").first();
const point = await view.evaluate((el) => {
  const second = el.querySelectorAll("br")[1];
  const b = second.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return {
    x: box.width / 2,
    y: b.top + b.height / 2 - box.top,
    brs: el.querySelectorAll("br").length,
  };
});
await view.click({ position: { x: point.x, y: point.y } });
await page.locator(".cm-content").waitFor();
await page.keyboard.type("ZZPROBE");
await page.keyboard.press("Escape");
let after = before;
for (let i = 0; i < 40 && after === before; i++) {
  await page.waitForTimeout(250);
  after = await storedContent(page, blockId);
}
const firstBlank = before.indexOf("\n\n");
console.log(
  JSON.stringify({
    b325: {
      brs: point.brs,
      newlines: before.split("\n").length - 1,
      markerAt: after.indexOf("ZZPROBE"),
      expectedAt: firstBlank + 1,
      head: JSON.stringify(after.slice(0, firstBlank + 12)),
    },
  }),
);

// --- B-326 -----------------------------------------------------------------------------------
await page.goto(`${base}/page/${encodeURIComponent(missing)}`);
await page.locator(".page-view-missing").waitFor();
await page.locator(".linked-references .reference-group-page").first().waitFor({ timeout: 30_000 });
const scrolled = await page.evaluate(() => {
  const last = [...document.querySelectorAll(".reference-item")].pop();
  last?.scrollIntoView({ block: "end" });
  window.rvPanel = document.querySelector(".references-panel");
  window.rvLoading = false;
  new MutationObserver(() => {
    if (document.querySelector(".references-loading")) window.rvLoading = true;
  }).observe(document.body, { childList: true, subtree: true });
  return document.querySelector(".page-scroll")?.scrollTop ?? -1;
});
await api(page, "page.create", { name: `render-views probe ${Date.now()}`, markdown: "- x" });
await page.waitForTimeout(3000);
const kept = await page.evaluate(() => ({
  samePanel: window.rvPanel === document.querySelector(".references-panel"),
  loadingSeen: window.rvLoading,
  scrollTop: document.querySelector(".page-scroll")?.scrollTop ?? -1,
}));
console.log(JSON.stringify({ b326: { scrolledTo: scrolled, ...kept } }));
console.log(JSON.stringify({ errors }));
await browser.close();
