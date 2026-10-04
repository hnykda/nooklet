// B-640 probe: the smallest single-device key sequence that leaves rows skipped by
// `content-visibility: auto` in WebKit. Prints which rows are skipped after each key.
// Usage: ENGINE=webkit|chromium KEYS="End,Enter,Shift+Tab,x,Enter,Escape" node one-device.mjs <baseURL>
import { chromium, webkit } from "@playwright/test";

const [base] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const { token } = await (await fetch(`${base}/api/session`)).json();
const api = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
const name = `one ${Date.now() % 100000}`;
await api("page.create", { name, markdown: process.env.MD ?? "- Ok\n  - Nothing" });
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForSelector(".vr-outliner .vr-row");
// STYLE="<css>": try a candidate fix without rebuilding.
if (process.env.STYLE) await page.addStyleTag({ content: process.env.STYLE });
const skipped = () =>
  page.locator(".vr-outliner .vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const v = r.querySelector(".vr-block-view") ?? r.querySelector(".cm-content");
      const s = v?.checkVisibility({ contentVisibilityAuto: true }) ? "" : "SKIPPED ";
      return `${s}${JSON.stringify((v?.textContent ?? "?").slice(0, 20))}`;
    }),
  );
await page.locator(".vr-block-view", { hasText: process.env.CLICK ?? "Nothing" }).click();
for (const key of (process.env.KEYS ?? "End,Enter,Shift+Tab,x,Enter,Escape").split(",")) {
  if (key.length === 1) await page.keyboard.type(key);
  else await page.keyboard.press(key);
  await page.waitForTimeout(Number(process.env.WAIT ?? 600));
  console.log(key.padEnd(10), (await skipped()).join("  "));
}
await browser.close();
