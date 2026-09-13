// Settles: do the owner's real `{{embed}}` blocks render their targets? (2026-09-13, B-210)
//
// The owner's graph (952 pages, 18.6k blocks) has six blocks containing `{{embed`, all block
// embeds carrying an earlier journal day's list forward; one is malformed (`}` instead of `}}`).
// For each host day this opens the page in Chromium against a server on a COPY of the graph and
// prints: embeds rendered, embedded rows, the embedded root's text, notices (cycle/missing/limit),
// and the source line — then writes a screenshot next to the graph copy.
//
// Run from `e2e/` (so `@playwright/test` resolves) against a server on a graph copy — never the
// live `~/.nooklet/default`:
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <dir> --port 6457 --no-mirror)
//   BASE=http://127.0.0.1:6457 OUT=<dir> node ../tools/probes/embeds-real-graph.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6457";
const OUT = process.env.OUT ?? ".";
const DAYS = (
  process.env.DAYS ?? "2023-01-06,2023-03-30,2024-02-17,2024-04-01,2024-09-29,2024-09-30"
).split(",");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

for (const day of DAYS) {
  const started = Date.now();
  await page.goto(`${BASE}/page/${day}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
  // Either rows land in an embed or the day has none (the malformed one).
  await page
    .locator(".vr-embed-item, .vr-embed-cycle, .vr-embed-missing, .vr-embed-failed")
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  const facts = await page.evaluate(() => {
    const embeds = [...document.querySelectorAll(".vr-outliner .vr-embed")];
    return embeds.map((e) => ({
      class: e.className,
      source: e.querySelector(".vr-embed-source")?.textContent ?? null,
      rows: e.querySelectorAll(".vr-embed-item").length,
      root: e.querySelector(".vr-embed-content")?.textContent?.slice(0, 60) ?? null,
      note: e.querySelector(".vr-embed-note")?.textContent ?? null,
    }));
  });
  const outlinerRows = await page.locator(".vr-outliner .vr-row").count();
  console.log(
    JSON.stringify({ day, ms: Date.now() - started, outlinerRows, embeds: facts }, null, 0),
  );
  await page.screenshot({ path: `${OUT}/embed-${day}.png`, fullPage: true });
}
console.log(JSON.stringify({ pageErrors: errors }));
await browser.close();
