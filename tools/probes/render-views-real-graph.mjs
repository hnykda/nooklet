/**
 * Probe (B-224, B-200 — `m9/render-views`): do the rendering fixes hold on the owner's real graph?
 *
 * - B-224: every multi-line paragraph block should render one `<br>` per newline. The owner's
 *   graph has ~500 multi-line blocks (imported highlights, Czech notes); this counts, on the pages
 *   given in PAGES, rows whose `<br>` count differs from their stored text's newline count.
 * - B-200: `/page/book` — no `book` page exists, but a page carries `tags:: book` and blocks say
 *   `[[book]]`. The missing-page view should list them, with the same totals `page.backlinks`
 *   reports.
 *
 * Usage (never point it at ~/.nooklet/default — copy the graph first):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6414
 *   URL=http://127.0.0.1:6414 MISSING=book PAGES='OmnivoreSync,2023-02-17' \
 *     node tools/probes/render-views-real-graph.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6414";
const missing = process.env.MISSING ?? "book";
const pages = (process.env.PAGES ?? "").split(",").filter(Boolean);

function pagePath(name) {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
// A console "Failed to load resource" does not say which one; this does.
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const out = {};

let t = Date.now();
await page.goto(`${base}/journals`);
await page.locator(".vr-outliner").first().waitFor({ timeout: 180_000 });
out.bootstrapMs = Date.now() - t;

// ── B-200 ──
const backlinks = await api(page, "page.backlinks", { target: missing, limit: 500 });
await page.goto(`${base}${pagePath(missing)}`);
await page.locator(".page-view-missing").waitFor({ timeout: 30_000 });
await page.locator(".references-panel").waitFor({ timeout: 30_000 });
await page.waitForTimeout(1000);
out.missingPage = {
  api: { linked_total: backlinks.linked_total, tagged_total: backlinks.tagged_total },
  shown: await page.evaluate(() => ({
    taggedLinks: document.querySelectorAll(".tagged-page-link").length,
    taggedCount:
      document.querySelector("[aria-label^='Pages tagged'] .reference-count")?.textContent ?? null,
    linkedCount: document.querySelector(".linked-references .reference-count")?.textContent ?? null,
    linkedItems: document.querySelectorAll(".linked-references .reference-item").length,
    unlinkedSection: document.querySelectorAll(".unlinked-references").length,
  })),
};

// ── B-224 ──
function flatten(nodes, acc = []) {
  for (const n of nodes ?? []) {
    acc.push(n);
    flatten(n.children, acc);
  }
  return acc;
}
/** Only what renders as one paragraph: no fence, table, quote, heading, rule or display math. */
function isParagraph(content) {
  const first = content.split("\n")[0];
  return !(
    content.includes("```") ||
    content.includes("|") ||
    content.includes("$$") ||
    /^\s*(#{1,6}\s|>|---\s*$)/.test(first)
  );
}
out.multiline = [];
for (const name of pages) {
  const read = await api(page, "page.read", { page: name, format: "json" });
  const byId = new Map(flatten(read.tree).map((b) => [b.id, b.content]));
  t = Date.now();
  await page.goto(`${base}${pagePath(name)}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".vr-outliner .vr-row[data-block-id]")].map((row) => ({
      id: row.getAttribute("data-block-id"),
      brs: row.querySelectorAll(":scope .vr-block-view > p.vr-paragraph > br").length,
    })),
  );
  let checked = 0;
  let multiline = 0;
  const mismatched = [];
  for (const r of rows) {
    const content = byId.get(r.id);
    if (content === undefined || !isParagraph(content)) continue;
    checked++;
    const newlines = content.split("\n").length - 1;
    if (newlines > 0) multiline++;
    if (r.brs !== newlines) mismatched.push({ id: r.id, newlines, brs: r.brs });
  }
  out.multiline.push({
    page: name,
    loadMs: Date.now() - t,
    rows: rows.length,
    paragraphRowsChecked: checked,
    multilineRows: multiline,
    mismatched: mismatched.slice(0, 10),
    mismatchedCount: mismatched.length,
  });
}

out.consoleErrors = errors.slice(0, 10);
console.log(JSON.stringify(out, null, 2));
await browser.close();
