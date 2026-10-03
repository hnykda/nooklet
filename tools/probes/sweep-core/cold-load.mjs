// Sweep: on a cold browser context (empty replica — first launch / new device / cleared storage),
// how long until today's journal can take a keystroke, and what is on screen meanwhile?
// Usage: OUT=<dir> node .../cold-load.mjs
import { BASE, launch, newPage, OUT } from "./lib.mjs";

const browser = await launch();
const { page } = await newPage(browser);
const t0 = Date.now();
await page.goto(`${BASE}/journals`);
const seen = {};
let shot = false;
while (Date.now() - t0 < 60000) {
  const s = await page.evaluate(() => {
    const d = document.querySelector(".journal-day-today");
    return {
      day: !!d,
      rows: d?.querySelectorAll(".vr-row").length ?? 0,
      draft: d?.querySelectorAll(".vr-draft-input").length ?? 0,
      emptyStart: d?.querySelectorAll(".vr-empty-start").length ?? 0,
      text: (d?.textContent ?? "").slice(0, 80),
      sync:
        document
          .querySelector("[class*='sync-indicator'], .sync-indicator")
          ?.getAttribute("aria-label") ?? null,
    };
  });
  const key = JSON.stringify(s);
  if (!seen[key]) {
    seen[key] = Date.now() - t0;
    console.log(`${String(Date.now() - t0).padStart(6)}ms ${key}`);
  }
  if (!shot && Date.now() - t0 > 1500) {
    await page.screenshot({ path: `${OUT}/cold-1500ms.png` });
    shot = true;
  }
  if (s.rows > 0 && Date.now() - t0 > 30000) break;
  await page.waitForTimeout(100);
}
console.log("ERRORS:", page.__errs.join("\n"));
await browser.close();
