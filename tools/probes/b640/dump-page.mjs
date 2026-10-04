// B-640 probe: open a page of a running nooklet server in headless Chromium and dump each row's
// depth, classes and visible text, in read mode. Usage: node dump-page.mjs <baseURL> <page name>
import { chromium } from "@playwright/test";

const [base, name] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text());
});
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForSelector(".vr-outliner .vr-row");
await page.waitForTimeout(1500);
const rows = await page.locator(".vr-outliner .vr-row").evaluateAll((rows) =>
  rows.map((r) => ({
    depth: r.style.getPropertyValue("--depth"),
    cls: r.className,
    id: r.getAttribute("data-block-id") ?? r.getAttribute("data-id"),
    text: r.querySelector(".vr-block-view")?.textContent ?? null,
    html: r.innerHTML.slice(0, 600),
  })),
);
for (const r of rows) console.log(JSON.stringify(r));
await page.screenshot({ path: process.env.SHOT ?? "/tmp/b640.png", fullPage: true });
await browser.close();
