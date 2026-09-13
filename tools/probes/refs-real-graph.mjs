/**
 * Probe (B-104, B-111): do alias routes and "Pages tagged X" hold up on the owner's real graph?
 *
 * The e2e specs use pages made up for the test. The owner's graph has the shapes that matter and
 * that fixtures tend not to: `alias:: daně` (a diacritic), `alias:: zahrada, Zahrada, garden` (a
 * repeated, differently-cased list), a `[[…]]`-wrapped alias containing commas on an imported
 * highlights page, a lowercase `journal` page carrying ~825 intrinsic journal tags (more than the
 * panel's 200-row request), and `tags:: book, design` on a page whose tags have no page of their
 * own. This drives the real app against `nooklet serve` on a COPY of that graph.
 *
 * Usage (never point it at ~/.nooklet/default — copy the graph first):
 *   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6406 --no-mirror
 *   URL=http://127.0.0.1:6406 node tools/probes/refs-real-graph.mjs
 *   pnpm nooklet verify --data <dir>
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6406";

function pagePath(name) {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function api(page, op, body) {
  return page.evaluate(
    async ([op, body]) => {
      // Loopback callers are handed a token by /api/session (B-25), as the e2e helpers do.
      const { token } = await (await fetch("/api/session")).json();
      const started = performance.now();
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { ms: Math.round(performance.now() - started), json: await res.json() };
    },
    [op, body],
  );
}

const browser = await chromium.launch();
const page = await browser.newPage();
const out = {};

// First load bootstraps the whole replica from the server; everything after is local.
let t = Date.now();
await page.goto(`${base}/journals`);
await page.locator(".vr-outliner").first().waitFor({ timeout: 180_000 });
out.bootstrapMs = Date.now() - t;

const aliasRoutes = [
  ["daně", "Taxes"],
  ["zahrada", "Garden"],
  ["GARDEN", "Garden"], // own key, other case: no redirect needed, must still resolve
  [
    "The Logic of Experimental Tests, Particularly of Everettian Quantum Theory",
    "hls__The_Logic_of_Experimental_Tests,_Particularly_of_Everettian_Quantum_Theory_-_David_Deutsch_1670184390828_0",
  ],
];
out.aliases = [];
for (const [alias, expected] of aliasRoutes) {
  t = Date.now();
  await page.goto(`${base}${pagePath(alias)}`);
  let ok = true;
  try {
    await page.locator(".page-title-input").first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      (want) => document.querySelector(".page-title-input")?.value === want,
      expected,
      { timeout: 60_000 },
    );
    if (alias.toLowerCase() !== expected.toLowerCase()) {
      await page.waitForURL(`${base}${pagePath(expected)}`, { timeout: 10_000 });
    }
  } catch {
    ok = false;
  }
  out.aliases.push({
    alias,
    ok,
    url: decodeURIComponent(new URL(page.url()).pathname),
    title: await page
      .locator(".page-title-input")
      .first()
      .inputValue()
      .catch(() => null),
    missing: await page.locator(".page-view-missing").count(),
    ms: Date.now() - t,
  });
}

// The journal tag page: count is the real total, the list is the 200 the panel asked for.
t = Date.now();
await page.goto(`${base}${pagePath("journal")}`);
const section = page.getByRole("region", { name: "Pages tagged journal" });
await section.waitFor({ timeout: 60_000 });
out.journalPage = {
  ms: Date.now() - t,
  count: await section.locator(".reference-count").first().textContent(),
  shown: await section.locator(".tagged-page-link").count(),
  first: await section
    .locator(".tagged-page-link")
    .evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent)),
  note: await section
    .locator(".references-empty")
    .textContent()
    .catch(() => null),
  sectionsInOrder: await page
    .locator(".references-panel > section")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))),
};

const journal = await api(page, "page.backlinks", { target: "journal", limit: 500 });
out.journalApi = {
  ms: journal.ms,
  tagged_total: journal.json.tagged_total,
  tagged_pages: journal.json.tagged_pages?.length,
  firstTwo: journal.json.tagged_pages?.slice(0, 2),
  cursor: journal.json.cursor !== undefined,
};
const book = await api(page, "page.backlinks", { target: "book" });
out.bookApi = { ms: book.ms, tagged_pages: book.json.tagged_pages, target: book.json.target };

await browser.close();
console.log(JSON.stringify(out, null, 2));
