// Settles: how long does the references panel take to render on the owner's busiest pages, and
// how much main-thread time does it block? (2026-09-13, B-550)
//
// B-550 turns each reference from one line of inline text into the block rendered as in its page,
// with its children. The owner's graph has pages with 750–1,100 linked references (`@alex`, `task`,
// `camp`, `weekly review`), which is where a richer row costs something. Run this before and
// after the change on the same graph copy and compare.
//
// For each page: a full load of `/page/<name>`, then waits until the linked-references section has
// rows and the row count has held still for 1.5 s. Prints: ms from navigation start to that
// moment, reference rows, outline rows rendered inside the panel, and main-thread stalls (>50 ms
// between 10 ms timer ticks) from navigation start (count, total, longest) — plus a screenshot.
//
// A persistent browser profile keeps the replica between pages (a fresh context would bootstrap
// 18.6k blocks every time). The first page is loaded twice and only the second load is reported.
//
// Run against a server on a COPY of the graph — never the live `~/.nooklet/default`:
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   pnpm --filter @nooklet/web build
//   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <dir> --port 6423 --no-mirror
//   BASE=http://127.0.0.1:6423 OUT=<scratch> node tools/probes/references-render-real-graph.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE ?? "http://127.0.0.1:6423";
const OUT = process.env.OUT ?? ".";
const LABEL = process.env.LABEL ?? "run";
const PAGES = (process.env.PAGES ?? "@alex,task,camp,weekly review,@robin").split(",");

// One profile per label: the app's service worker precaches the build, and a profile shared
// between a before and an after run would serve the first run's bundle to the second.
const profile = join(OUT, `probe-profile-${LABEL}`);
mkdirSync(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1100, height: 1400 },
});
await context.addInitScript(() => {
  const w = window;
  // Main-thread stalls, sampled with a 10 ms timer: a gap over 50 ms between ticks is time the
  // page could not respond. (The Long Tasks API reports nothing in headless Chromium here — a
  // deliberate 120 ms busy loop produced no entry — so it is measured by hand.)
  w.__stalls = [];
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - lastTick > 50) w.__stalls.push({ at: lastTick, ms: now - lastTick });
    lastTick = now;
  }, 10);
  // When the panel first showed a reference row, and when anything inside it last changed.
  w.__firstRow = null;
  w.__lastPanelChange = null;
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!el?.closest(".references-panel")) continue;
      w.__lastPanelChange = performance.now();
      if (w.__firstRow === null && document.querySelector(".linked-references .reference-item")) {
        w.__firstRow = performance.now();
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let backlinksRequests = 0;
page.on("request", (r) => {
  if (r.url().includes("page.backlinks")) backlinksRequests++;
});

function pagePath(name) {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function measure(name) {
  await page.goto(`${BASE}${pagePath(name)}`);
  const section = page.locator(".linked-references");
  await section.locator(".reference-item").first().waitFor({ timeout: 120_000 });
  // Settled: the same row count (references and outline rows) for 1.5 s.
  let last = "";
  let stableSince = Date.now();
  for (;;) {
    const now = await page.evaluate(() => {
      const s = document.querySelector(".linked-references");
      return `${s?.querySelectorAll(".reference-item").length}/${s?.querySelectorAll(".vr-embed-item").length}`;
    });
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 1500) break;
    await page.waitForTimeout(100);
  }
  return page.evaluate(() => {
    const s = document.querySelector(".linked-references");
    const tasks = window.__stalls ?? [];
    return {
      firstRowMs: Math.round(window.__firstRow ?? -1),
      lastPanelChangeMs: Math.round(window.__lastPanelChange ?? -1),
      count: s?.querySelector(".references-toggle .reference-count")?.textContent,
      referenceItems: s?.querySelectorAll(".reference-item").length,
      outlineRows: s?.querySelectorAll(".vr-embed-item").length,
      breadcrumbs: s?.querySelectorAll(".reference-breadcrumb").length,
      stalls: tasks.length,
      stallMs: Math.round(tasks.reduce((a, t) => a + t.ms, 0)),
      longestStallMs: Math.round(Math.max(0, ...tasks.map((t) => t.ms))),
    };
  });
}

/**
 * A write elsewhere in the graph while the page is open: the panel refetches `page.backlinks` and
 * re-reads the replica. Reports the stalls in the 3 s after it, and whether the first rendered
 * reference is still the same DOM element (rows keyed by id survive; rows keyed by object do not).
 * Writes one block to a page named "Probe Scratch" — on the graph COPY.
 */
async function measureRefetch() {
  const requestsBefore = backlinksRequests;
  await page.evaluate(() => {
    const first = document.querySelector(".linked-references .reference-item");
    if (first) first.__probeMark = true;
    window.__stalls.length = 0;
  });
  await page.evaluate(async () => {
    const { token } = await (await fetch("/api/session")).json();
    const post = (op, body) =>
      fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    await post("page.create", { name: "Probe Scratch", if_exists: "return" });
    await post("page.append", { page: "Probe Scratch", markdown: `- probe ${Date.now()}` });
  });
  await page.waitForTimeout(3000);
  const refetched = backlinksRequests > requestsBefore;
  return page.evaluate((refetched) => {
    const tasks = window.__stalls;
    const first = document.querySelector(".linked-references .reference-item");
    return {
      refetchStalls: tasks.length,
      refetchStallMs: Math.round(tasks.reduce((a, t) => a + t.ms, 0)),
      refetched,
      firstRowKept: first?.__probeMark === true,
    };
  }, refetched);
}

await measure(PAGES[0]); // warm: replica bootstrap, chunk cache
for (const name of PAGES) {
  const facts = await measure(name);
  const refetch = await measureRefetch();
  console.log(JSON.stringify({ label: LABEL, page: name, ...facts, ...refetch }));
  // The first screenful of the section only: the whole of a 756-reference list is too tall to be
  // a useful image.
  const box = await page.locator(".linked-references").boundingBox();
  if (box) {
    // `boundingBox` is relative to the viewport, so scroll BY it.
    await page.evaluate((y) => window.scrollBy(0, y), box.y);
    await page.screenshot({
      path: join(OUT, `refs-${LABEL}-${name.replace(/[^a-z0-9]+/gi, "_")}.png`),
    });
  }
}
console.log(JSON.stringify({ pageErrors: errors }));
await context.close();
