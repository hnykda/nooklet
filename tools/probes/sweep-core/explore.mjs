// Readiness sweep (2026-10-03), phase 0: first load on the real imported graph + DOM survey.
// Usage: OUT=<dir> node tools/probes/sweep-core/explore.mjs [path]   (server on 127.0.0.1:6310)
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:6310";
const OUT = process.env.OUT ?? ".";
const path = process.argv[2] ?? "/journals";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errs.push(`console: ${m.text()}`));
const t0 = Date.now();
await page.goto(BASE + path);
await page.locator(".vr-row, .vr-draft-input").first().waitFor({ timeout: 60000 });
console.log("first row visible ms", Date.now() - t0, page.url());
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/explore.png` });
console.log(await page.evaluate(() => document.body.innerText.slice(0, 1500)));
console.log(errs.join("\n"));
await browser.close();
