// Run from `e2e/` against a server on a COPY of the graph (never ~/.nooklet/default), e.g.
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <dir> --port 6407 --no-mirror)
//   BASE=http://127.0.0.1:6407 node ../tools/probes/<this file>
// Written 2026-09-13 while verifying m8/impl-embeds; see docs/bugs-inbox/impl-embeds.md.
// An external link inside an embedded row (the owner's 2024-09-29 embed has one): does clicking it
// open the URL, as it does on the block's own page, or navigate to the block?
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6407";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
// Don't hit the network: answer any external request locally.
await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) =>
  r.fulfill({ status: 200, body: "external" }),
);
const page = await context.newPage();
const out = {};
for (const [label, url, sel] of [
  ["embed", `${BASE}/page/2024-09-29`, ".vr-embed .vr-embed-content a.vr-link"],
  [
    "own page",
    `${BASE}/page/2024-09-26?block=1m287mdbkcaggw`,
    ".vr-outliner .vr-block-view a.vr-link",
  ],
]) {
  await page.goto(url);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 60_000 });
  const link = page.locator(sel, { hasText: "mattermost" }).first();
  await link.waitFor({ timeout: 10_000 });
  const popup = context
    .waitForEvent("page", { timeout: 3000 })
    .then((p) => p.url())
    .catch(() => null);
  await link.click();
  out[label] = { popup: await popup, urlAfter: page.url().replace(BASE, "") };
  for (const p of context.pages()) if (p !== page) await p.close();
}
console.log(JSON.stringify(out));
await browser.close();
