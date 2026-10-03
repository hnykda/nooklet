/**
 * How long until the Search view shows the device's own hits, and how long until the server's
 * semantic matches are merged in? (server-search, 2026-10-03.) Real Chromium, the real production
 * build, a real `nooklet serve` — point it at a server holding a real graph.
 *
 * Timed inside the page: the input's value is set and an `input` event dispatched from page script,
 * and a MutationObserver records when the result summary first reflects the new query (the
 * device's keyword answer) and when `.search-source` says the server answered (`data-source` =
 * `answered` / `fell-back` / `timed-out` / `failed`). The server figure includes the view's 250 ms
 * typing pause (`ENRICH_DEBOUNCE_MS`) before it asks.
 *
 * First waits until the replica has synced the graph (the summary for WARMUP shows a result).
 *
 * Caveat: "device" is the first change to the result list after the query is set. When the new
 * query's device answer renders exactly the same rows as the previous one (rep 2 of a query, or two
 * queries the device finds nothing for), the list does not change until the server's matches are
 * merged, so that line shows the server's time — read only rep 1 after a different query.
 *
 * Result (2026-10-03, M-series Mac at high load, copy of the owner's graph: 1,211 pages, 18,628
 * blocks, server with the test-only `fake` embedding provider over 14,711 vectors, loopback):
 * device 2–4 ms; server's matches merged 256–270 ms after the keystroke, of which 250 ms is the
 * deliberate typing pause — the request itself ~6–20 ms. A real model adds its query embedding
 * (bge-m3 warm ≈ 0.08 s per B-522's notes) and a phone adds its network round trip.
 *
 * Usage: node tools/probes/search-latency.mjs <baseURL> <warmup word> <query> [query ...]
 */

import { createRequire } from "node:module";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const [baseURL, warmup, ...queries] = process.argv.slice(2);
if (!baseURL || !warmup || queries.length === 0) {
  console.error("usage: search-latency.mjs <baseURL> <warmup word> <query> [query ...]");
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${baseURL}/search`);
await page.locator(".search-query-input").waitFor();
const syncStart = Date.now();
await page.locator(".search-query-input").fill(warmup);
await page.locator(".search-result").first().waitFor({ timeout: 300_000 });
console.log(`replica synced and searchable after ${Date.now() - syncStart} ms`);

for (const query of queries) {
  for (const rep of [1, 2]) {
    await page.locator(".search-query-input").fill("");
    await page.waitForTimeout(400);
    const t = await page.evaluate(
      (q) =>
        new Promise((resolve) => {
          const input = document.querySelector(".search-query-input");
          const out = {};
          let t0 = 0;
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            obs.disconnect();
            // The server's hits are merged once the replica has said which of them it holds
            // (one more worker round trip), so read the final state a moment later.
            setTimeout(() => {
              out.semanticRows = document.querySelectorAll(".search-result[data-semantic]").length;
              out.line = document.querySelector(".search-source")?.textContent;
              out.results = document.querySelector(".search-summary")?.textContent;
              resolve(out);
            }, 300);
          };
          // The previous query's rows stay on screen until the new answer replaces them (a
          // resource keeps its last value while loading), so "the device answered" is the first
          // change to the result list itself after the query was set.
          const obs = new MutationObserver((records) => {
            const now = performance.now();
            const listChanged = records.some((r) => {
              const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
              return el?.closest?.(".search-results, .search-summary");
            });
            if (out.local === undefined && listChanged) {
              out.local = now - t0;
              out.results = document.querySelector(".search-summary")?.textContent;
            }
            const src = document.querySelector(".search-source")?.getAttribute("data-source");
            const fell = document.querySelector(".search-fallback");
            if (
              out.server === undefined &&
              (fell || (src && src !== "pending" && src !== "not-asked"))
            ) {
              out.server = now - t0;
              out.source = fell ? "fell-back" : src;
              out.line = document.querySelector(".search-source")?.textContent;
            }
            if (out.local !== undefined && out.server !== undefined) done();
          });
          obs.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          setTimeout(done, 10_000);
          t0 = performance.now();
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      query,
    );
    console.log(
      `${JSON.stringify(query)} rep ${rep}: device ${t.local?.toFixed(1)} ms (${t.results}); ` +
        `server ${t.server?.toFixed(1)} ms (${t.source}); ${t.semanticRows} semantic rows; ${t.line ?? ""}`,
    );
  }
}
await browser.close();
