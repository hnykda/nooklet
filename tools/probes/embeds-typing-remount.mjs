// Run from `e2e/` against a server on a COPY of the graph (never ~/.nooklet/default), e.g.
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <dir> --port 6407 --no-mirror)
//   BASE=http://127.0.0.1:6407 node ../tools/probes/<this file>
// Written 2026-09-13 while verifying m8/impl-embeds; see docs/bugs-inbox/impl-embeds.md.
// Which elements does typing in block 0 re-create on the same page? Host row view, embed frame,
// embed outline, another row's paragraph.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6407";
const DAY = process.env.DAY ?? "2024-09-29";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
await page.goto(`${BASE}/page/${DAY}`);
await page.locator(".vr-outliner .vr-embed-item").first().waitFor({ timeout: 60_000 });
await page.evaluate(() => {
  const embed = document.querySelector(".vr-outliner .vr-embed");
  const hostRow = embed.closest(".vr-row");
  window.__els = {
    hostRow,
    hostView: hostRow.querySelector(".vr-block-view"),
    embedFrame: embed,
    outline: embed.querySelector(".vr-embed-outline"),
    firstItem: embed.querySelector(".vr-embed-item"),
    otherParagraph: [...document.querySelectorAll(".vr-outliner .vr-row")]
      .at(-1)
      .querySelector(".vr-paragraph"),
  };
  window.__heights = [];
  new ResizeObserver(() =>
    window.__heights.push(Math.round(hostRow.getBoundingClientRect().height)),
  ).observe(hostRow);
});
await page.locator(".vr-outliner .vr-row").first().locator(".vr-block-view").click();
await page.locator(".cm-content").waitFor();
await page.keyboard.press("End");
await page.keyboard.type("q");
await page.waitForTimeout(2000);
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      connected: Object.fromEntries(
        Object.entries(window.__els).map(([k, v]) => [k, v?.isConnected ?? null]),
      ),
      hostRowHeights: window.__heights,
    })),
  ),
);
await page.keyboard.press("Backspace");
await page.waitForTimeout(1000);
await browser.close();
