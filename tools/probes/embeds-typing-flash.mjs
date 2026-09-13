// Run from `e2e/` against a server on a COPY of the graph (never ~/.nooklet/default), e.g.
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <dir> --port 6407 --no-mirror)
//   BASE=http://127.0.0.1:6407 node ../tools/probes/<this file>
// Written 2026-09-13 while verifying m8/impl-embeds; see docs/bugs-inbox/impl-embeds.md.
// Typing in a block BELOW an embed / a query fence: does the host row collapse to the placeholder
// and back (height samples), and does the caret's row jump on screen?
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6407";
const NAME = process.env.NAME ?? "Verify Flash";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const { token } = await (await page.request.get(`${BASE}/api/session`)).json();
const api = async (op, body) => {
  const r = await page.request.post(`${BASE}/api/v1/${op}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: body,
  });
  if (!r.ok()) throw new Error(`${op} ${r.status()} ${await r.text()}`);
  return r.json();
};
await api("page.create", {
  name: NAME,
  if_exists: "return",
  markdown: [
    "- start",
    "- {{embed [[2024-09-29]]}}",
    "- ```query",
    "  task:TODO",
    "  ```",
    "- typing here",
  ].join("\n"),
});
await page.goto(`${BASE}/page/${encodeURIComponent(NAME)}`);
await page.locator(".vr-outliner .vr-embed-item").first().waitFor({ timeout: 60_000 });
await page
  .locator(".vr-outliner .vr-query-hit")
  .first()
  .waitFor({ timeout: 60_000 })
  .catch(() => {});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".vr-outliner .vr-row")];
  window.__h = { embed: [], query: [] };
  new ResizeObserver(() =>
    window.__h.embed.push(Math.round(rows[1].getBoundingClientRect().height)),
  ).observe(rows[1]);
  new ResizeObserver(() =>
    window.__h.query.push(Math.round(rows[2].getBoundingClientRect().height)),
  ).observe(rows[2]);
});
const last = page.locator(".vr-outliner .vr-row").last();
await last.locator(".vr-block-view").scrollIntoViewIfNeeded();
await last.locator(".vr-block-view").click();
await page.locator(".cm-content").waitFor();
await page.keyboard.press("End");
const tops = [];
for (const ch of "abcdef") {
  await page.keyboard.type(ch);
  for (let i = 0; i < 8; i++) {
    tops.push(Math.round((await page.locator(".cm-content").boundingBox())?.y ?? -1));
    await page.waitForTimeout(40);
  }
}
await page.waitForTimeout(1500);
const text = await page.evaluate(() =>
  [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"),
);
for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
await page.waitForTimeout(1500);
console.log(
  JSON.stringify({
    heights: await page.evaluate(() => window.__h),
    editorTops: [...new Set(tops)],
    text,
    errors,
  }),
);
await browser.close();
