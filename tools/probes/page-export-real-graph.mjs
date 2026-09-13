// Settles: on a REAL graph, is "Export page as markdown" in the browser byte-identical to the
// markdown mirror file `nooklet serve` writes for the same page? (2026-09-13, impl-export, B-220)
//
// The e2e test proves it for one hand-made page. Bugs hide in the shape of real data — 952 pages,
// Czech + English, heavy task markers, Logseq-imported properties — so this exports the pages most
// likely to differ (most blocks, most properties, most task dates, most multi-line blocks, a few
// journals) through the real UI and compares each download with the mirror file on disk.
//
// Result on the owner's graph copy of 2026-09-13 is recorded in docs/progress/impl-export.md.
//
// Run from `e2e/` (so `@playwright/test` resolves), against a server serving a COPY of a graph
// (never ~/.nooklet/default) with a current client build:
//   DATA=<copy dir> BASE=http://127.0.0.1:6408 node ../tools/probes/page-export-real-graph.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6408";
const DATA = process.env.DATA;
if (!DATA) throw new Error("set DATA to the served graph's data dir");
const PER_QUERY = Number(process.env.PER_QUERY ?? 6);

const db = new DatabaseSync(join(DATA, "graph.sqlite"), { readOnly: true });
const pick = (sql) =>
  db
    .prepare(sql)
    .all(PER_QUERY)
    .map((r) => r.name);
const live = "p.deleted_at IS NULL";
const names = new Set([
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           WHERE ${live} GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           JOIN block_prop bp ON bp.block_id = b.id AND bp.value IS NOT NULL
           WHERE ${live} GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           WHERE ${live} AND (b.scheduled_day IS NOT NULL OR b.deadline_day IS NOT NULL
                              OR b.done_at IS NOT NULL OR b.repeat IS NOT NULL)
           GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           WHERE ${live} AND instr(b.content, char(10)) > 0
           GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN page_prop pp ON pp.page_id = p.id AND pp.value IS NOT NULL
           WHERE ${live} GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           WHERE ${live} AND p.journal_day IS NOT NULL
           GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
  ...pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id AND b.deleted_at IS NULL
           WHERE ${live} AND b.collapsed = 1 GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`),
]);
const journalOf = new Map(
  db
    .prepare(`SELECT name, journal_day FROM page p WHERE ${live}`)
    .all()
    .map((r) => [r.name, r.journal_day]),
);

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const results = [];
for (const name of names) {
  const path = `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
  await page.goto(`${BASE}${path}`);
  await page.getByRole("button", { name: "Page actions" }).click({ timeout: 60_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".page-actions-item", { hasText: "Export as markdown" }).click(),
  ]);
  const file = download.suggestedFilename();
  const dir = journalOf.get(name) === null ? "pages" : "journals";
  const got = readFileSync(await download.path(), "utf8");
  const want = readFileSync(join(DATA, dir, file), "utf8");
  results.push({ name, file: `${dir}/${file}`, chars: want.length, identical: got === want });
  if (got !== want) {
    const a = got.split("\n");
    const b = want.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    console.log(`DIFF ${name} at line ${i + 1}:\n  browser: ${a[i]}\n  mirror:  ${b[i]}`);
  }
}
console.table(results);
const bad = results.filter((r) => !r.identical).length;
console.log(
  `${results.length} pages exported, ${results.length - bad} identical, ${bad} different`,
);

// Print (B-221): for the pages with the most collapsed blocks, every live block must be in the DOM
// while the page is laid out for paper — the rows `beforeprint` sees vs. the blocks reachable
// from the page's roots in the database.
const reachable = db.prepare(`
  WITH RECURSIVE t(id) AS (
    SELECT b.id FROM block b JOIN page p ON p.id = b.page_id
    WHERE p.name = ? AND b.parent_id IS NULL AND b.deleted_at IS NULL
    UNION ALL
    SELECT c.id FROM block c JOIN t ON c.parent_id = t.id WHERE c.deleted_at IS NULL
  ) SELECT count(*) AS n FROM t`);
// Pages over 2,000 blocks are skipped to bound the PDF layout time on someone else's graph. (On the
// owner's copy the heaviest page, 1.7 MB in 961 blocks, is under the cap: 367 sheets, all rows.)
const collapsedPages = pick(`SELECT p.name FROM page p JOIN block b ON b.page_id = p.id
  AND b.deleted_at IS NULL WHERE ${live} AND b.collapsed = 1
  AND (SELECT count(*) FROM block x WHERE x.page_id = p.id) < 2000
  GROUP BY p.id ORDER BY count(*) DESC LIMIT ?`);
const prints = [];
for (const name of collapsedPages) {
  await page.goto(`${BASE}/page/${name.split("/").map(encodeURIComponent).join("/")}`);
  await page.getByRole("button", { name: "Page actions" }).waitFor({ timeout: 60_000 });
  await page.locator(".vr-outliner .vr-row").first().waitFor();
  const onScreen = await page.locator(".vr-outliner .vr-row").count();
  await page.evaluate(() => {
    window.addEventListener(
      "beforeprint",
      () => {
        window.__rows = document.querySelectorAll(".vr-outliner .vr-row").length;
      },
      { once: true },
    );
  });
  const pdf = await page.pdf();
  const sheets = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  const printed = await page.evaluate(() => window.__rows);
  const inDb = reachable.get(name).n;
  prints.push({ name, onScreen, printed, inDb, sheets, allPrinted: printed === inDb });
}
await browser.close();
console.table(prints);
const short = prints.filter((p) => !p.allPrinted).length;
console.log(`${prints.length} pages printed, ${short} missing rows`);
process.exit(bad === 0 && short === 0 ? 0 : 1);
