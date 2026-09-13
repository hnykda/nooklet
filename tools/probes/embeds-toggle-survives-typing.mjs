// Run from `e2e/` against a server on a COPY of the graph (never ~/.nooklet/default), e.g.
//   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
//   (cd packages/server && pnpm exec tsx src/cli.ts serve --data <dir> --port 6407 --no-mirror)
//   BASE=http://127.0.0.1:6407 node ../tools/probes/<this file>
// Written 2026-09-13 while verifying m8/impl-embeds; see docs/bugs-inbox/impl-embeds.md.
// Expand a folded row inside an embed, then type in ANOTHER block of the host page: does the
// view-local expansion survive? Also: is the Tab-focused embed row still focused after a write?
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6407";
const SUFFIX = process.env.SUFFIX ?? String(Date.now());
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const { token } = await (await page.request.get(`${BASE}/api/session`)).json();
const api = async (op, body) => {
  const r = await page.request.post(`${BASE}/api/v1/${op}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: body,
  });
  if (!r.ok()) throw new Error(`${op} ${r.status()} ${await r.text()}`);
  return r.json();
};
const src = `Verify Toggle Src ${SUFFIX}`,
  host = `Verify Toggle Host ${SUFFIX}`;
await api("page.create", {
  name: src,
  markdown: "- list\n  - call bob\n    collapsed:: true\n    - about the car\n  - pay rent",
});
const tree = (await api("page.read", { page: src, format: "json" })).tree;
await api("page.create", { name: host, markdown: `- type here\n- {{embed ((${tree[0].id}))}}` });
await page.goto(`${BASE}/page/${encodeURIComponent(host)}`);
const embed = page.locator(".vr-embed-block");
await embed.locator(".vr-embed-item").first().waitFor();
await embed.locator(".vr-embed-toggle[aria-expanded=false]").click();
await page.waitForTimeout(300);
const expandedBefore = await embed.getByText("about the car").count();
await page.locator(".vr-outliner .vr-row").first().locator(".vr-block-view").click();
await page.locator(".cm-content").waitFor();
await page.keyboard.press("End");
await page.keyboard.type(" x");
await page.waitForTimeout(2000);
const expandedAfterTyping = await embed.getByText("about the car").count();
console.log(JSON.stringify({ expandedBefore, expandedAfterTyping }));
await browser.close();
