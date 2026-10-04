/**
 * Probe (B-645): are All pages' block/word columns fast enough on the owner's real graph?
 *
 * The counts are one query over every live block plus a JS tally (`apps/web/src/data/
 * page-stats.ts`), redone whenever any block changes while the view is open. This drives the real
 * production build against `nooklet serve` on an IMPORTED COPY of the graph and reports, as
 * medians over RUNS:
 *   - load:   `goto /pages` → the first row's Words cell shows a non-zero number
 *   - sort:   click "Sort by words" → first row changed
 *   - edit:   `page.append` of one block over the API → that page's Words cell updated (includes
 *             the sync pull, so it is an upper bound on the refetch itself)
 *   - all:    tick Journals (every page on screen) → row count settled
 *
 * Usage (copy the graph first; never import from the original directory in place):
 *   rsync -a --exclude .git <graph>/ <scratch>/alpha-copy/
 *   pnpm nooklet import <scratch>/alpha-copy --data <scratch>/data
 *   pnpm --filter @nooklet/web build
 *   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <scratch>/data --port 6426 --no-mirror
 *   URL=http://127.0.0.1:6426 node tools/probes/all-pages-columns-real-graph.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.URL ?? "http://127.0.0.1:6426";
const RUNS = Number(process.env.RUNS ?? 5);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// Most recently edited pages on a real graph are empty (referenced-only), so "any row".
const firstWords = (timeout = 60_000) =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll('.all-pages-row [data-col="words"]')].some(
        (c) => c.textContent !== "0",
      ),
    null,
    { timeout, polling: "raf" },
  );

await page.goto(`${base}/pages`);
await firstWords(300_000);

const load = [];
const sort = [];
const edit = [];
const all = [];
for (let i = 0; i < RUNS; i++) {
  let t = Date.now();
  await page.goto(`${base}/pages`);
  await firstWords();
  load.push(Date.now() - t);

  const before = await page.locator(".all-pages-name").first().textContent();
  t = Date.now();
  await page.getByRole("button", { name: "Sort by words" }).click();
  await page.waitForFunction(
    (b) => document.querySelector(".all-pages-name")?.textContent !== b,
    before,
    { polling: "raf" },
  );
  sort.push(Date.now() - t);

  // The top page by words: append one 3-word block, wait for its count to move by 3.
  const name = await page.locator(".all-pages-name").first().textContent();
  const words = Number(
    (await page.locator('.all-pages-row [data-col="words"]').first().textContent()).replace(
      /\D/g,
      "",
    ),
  );
  t = Date.now();
  // Token as the e2e helpers get it (`e2e/helpers/api.ts`): `/api/session` hands loopback one.
  const { token } = await (await page.request.get(`${base}/api/session`)).json();
  const r = await page.request.post(`${base}/api/v1/page.append`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    data: { page: name, markdown: "- probe probe probe" },
  });
  const res = `${r.status()} ${r.ok() ? "" : await r.text()}`;
  if (i === 0) console.log("append:", name, words, res);
  await page.waitForFunction(
    (w) =>
      Number(
        document
          .querySelector('.all-pages-row [data-col="words"]')
          ?.textContent?.replace(/\D/g, ""),
      ) === w,
    words + 3,
    { timeout: 30_000, polling: "raf" },
  );
  edit.push(Date.now() - t);

  t = Date.now();
  await page.locator(".all-pages-toggle input").check();
  const total = await page.waitForFunction(
    () => {
      const n = document.querySelectorAll(".all-pages-row").length;
      return n > 1000 ? n : false;
    },
    null,
    { polling: "raf" },
  );
  all.push(Date.now() - t);
  if (i === 0) console.log("rows with journals:", await total.jsonValue());
}

console.log(JSON.stringify({ runs: RUNS, load, sort, edit, all }));
console.log(
  `median ms — load→counts ${median(load)}, sort ${median(sort)}, edit→count ${median(edit)}, journals on ${median(all)}`,
);
await browser.close();
