// Probe (2026-09-13, impl-dates; B-102, B-143): do the date chips render the owner's real
// scheduled tasks, and does a chip open the picker on its own date?
//
// Setup, never against ~/.nooklet/default:
//   pnpm nooklet import ~/notes-graph --data <scratch>/import-alpha
//   pnpm --filter @nooklet/web build
//   pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data <scratch>/import-alpha --port <p> --no-mirror
//   NOOKLET_PROBE_URL=http://127.0.0.1:<p> NOOKLET_PROBE_OUT=<scratch> node tools/probes/date-chips-real-graph.mjs
//
// Result when written (after the B-143 import fix): /page/2023-02-17 rendered 26 rows and 19 chips
// (the DB has 19 blocks scheduled that day), 18 `vr-date-closed` (DONE) and one plain `past`
// (a block with no marker); the first chip's picker opened on 20230217; no page or console
// errors; screenshot `real-2023-02-17.png` in the out dir.
import { chromium } from "@playwright/test";

const base = process.env.NOOKLET_PROBE_URL ?? "http://127.0.0.1:6400";
const out = process.env.NOOKLET_PROBE_OUT ?? ".";

for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${base}/page/2023-02-17`);
await page.locator(".vr-row").first().waitFor({ timeout: 120_000 });
// The replica syncs in the background: wait until the chip count stops changing.
let last = -1;
for (let i = 0; i < 60; i++) {
  const n = await page.locator(".vr-date").count();
  if (n === last && n > 0) break;
  last = n;
  await page.waitForTimeout(1000);
}
const chips = await page
  .locator(".vr-date")
  .evaluateAll((els) =>
    els.map((e) => ({ cls: e.className, value: e.getAttribute("data-value") })),
  );
const tones = {};
for (const c of chips) {
  const tone = c.cls
    .split(" ")
    .find((k) => /^vr-date-(overdue|today|upcoming|past|closed)$/.test(k));
  tones[tone] = (tones[tone] ?? 0) + 1;
}
console.log(
  JSON.stringify({ rows: await page.locator(".vr-row").count(), chips: chips.length, tones }),
);
await page.screenshot({ path: `${out}/real-2023-02-17.png` });

await page.locator(".vr-date").first().click();
await page.locator(".date-picker").waitFor();
console.log("picker opened on:", await page.locator(".dp-day--active").getAttribute("data-day"));
await page.keyboard.press("Escape");
console.log("errors:", JSON.stringify(errors));
await browser.close();
