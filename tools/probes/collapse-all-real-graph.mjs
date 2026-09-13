/**
 * Probe (B-97): does "Collapse all" / "Expand all" hold up on a real, large page?
 *
 * The e2e tests use six-block pages. The owner's graph has pages with ~1,000 blocks and ~150
 * parents, and a batch of one `collapsed` op per parent is exactly the shape that can go wrong only
 * at size (a slow commit, a partial sync, rows that do not settle). This drives the real app against
 * a `nooklet serve` on a COPY of that graph and reports rows on screen and the server's own flags.
 *
 * Usage (never point it at ~/.nooklet/default — copy the graph first):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6402 --no-mirror
 *   URL=http://127.0.0.1:6402 PAGE=OmnivoreSync node tools/probes/collapse-all-real-graph.mjs
 *   pnpm nooklet verify --data <dir>
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6402";
const pageName = process.env.PAGE ?? "OmnivoreSync";
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function serverTree(page) {
  return page.evaluate(async (name) => {
    const token = window.__NOOKLET__?.token;
    const res = await fetch("/api/v1/page.read", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ page: name, format: "json" }),
    });
    const out = await res.json();
    let blocks = 0;
    let parents = 0;
    let collapsedParents = 0;
    let collapsedLeaves = 0;
    const walk = (nodes) => {
      for (const n of nodes ?? []) {
        blocks++;
        const hasKids = (n.children ?? []).length > 0;
        if (hasKids) parents++;
        if (n.collapsed && hasKids) collapsedParents++;
        if (n.collapsed && !hasKids) collapsedLeaves++;
        walk(n.children);
      }
    };
    walk(out.tree);
    return { top: (out.tree ?? []).length, blocks, parents, collapsedParents, collapsedLeaves };
  }, pageName);
}

async function rows(page) {
  return page.locator(".vr-outliner").first().locator(".vr-row").count();
}

async function waitRows(page, want, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let n = -1;
  while (Date.now() < deadline) {
    n = await rows(page);
    if (n === want) return n;
    await page.waitForTimeout(100);
  }
  throw new Error(`rows never reached ${want} (last ${n})`);
}

async function waitServer(page, pred, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await serverTree(page);
    if (pred(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`server never matched: ${JSON.stringify(last)}`);
}

async function runFromPalette(page, title) {
  await page.keyboard.press(`${mod}+k`);
  const input = page.locator(".cmd-palette .cmd-input");
  await input.fill(">");
  await input.fill(title);
  await page
    .locator(".cmd-palette .cmd-row")
    .filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${title}$`) }) })
    .click();
  await page.locator(".cmd-palette").waitFor({ state: "detached" });
}

const browser = await chromium.launch();
const page = await browser.newPage();
const report = { page: pageName };
try {
  await page.goto(`${base}/page/${encodeURIComponent(pageName)}`);
  // The replica pulls the whole graph first; the page renders once its blocks have arrived.
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 600_000 });
  report.before = await serverTree(page);
  await page.waitForTimeout(2000);
  report.rowsBefore = await rows(page);

  let t = Date.now();
  await runFromPalette(page, "Expand all");
  report.rowsAfterExpand = await waitRows(page, report.before.blocks);
  report.expandMs = Date.now() - t;
  t = Date.now();
  report.serverAfterExpand = await waitServer(page, (s) => s.collapsedParents === 0);
  report.expandSyncedMs = Date.now() - t;

  t = Date.now();
  await runFromPalette(page, "Collapse all");
  report.rowsAfterCollapse = await waitRows(page, report.before.top);
  report.collapseMs = Date.now() - t;
  t = Date.now();
  report.serverAfterCollapse = await waitServer(page, (s) => s.collapsedParents === s.parents);
  report.collapseSyncedMs = Date.now() - t;

  await page.reload();
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  report.rowsAfterReload = await rows(page);
} finally {
  await browser.close();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
