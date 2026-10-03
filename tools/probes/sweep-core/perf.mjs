// Sweep phase 6: performance on the real graph — largest page open, typing on it, All pages,
// a warm reload of the journals. Usage: OUT=<dir> node .../perf.mjs
import { BASE, editorText, launch, newPage, OUT, results, step, waitFor } from "./lib.mjs";

const browser = await launch();
const { page } = await newPage(browser);
await page.goto(`${BASE}/journals`);
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});
await page.waitForTimeout(3000); // let the replica finish its first pull

await step("warm reload of /journals until today interactive", async () => {
  const t0 = Date.now();
  await page.reload();
  await page.locator(".journal-day-today").waitFor();
  await waitFor(
    async () => !(await page.locator(".journal-day-today").textContent()).includes("Loading"),
    20000,
    20,
  );
  return { ms: Date.now() - t0 };
});

await step("open the largest page (OmnivoreSync, ~9.4k lines of markdown)", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/page/OmnivoreSync`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 30000 });
  const firstRow = Date.now() - t0;
  await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
    timeout: 30000,
  });
  const rows = await page.locator(".vr-row").count();
  return { firstRowMs: firstRow, settledMs: Date.now() - t0, renderedRows: rows };
});

await step("typing latency on the largest page (per key, keydown -> DOM)", async () => {
  const row = page.locator(".vr-outliner .vr-row").nth(1);
  const b = await row.boundingBox();
  await page.mouse.click(b.x + b.width - 6, b.y + 10);
  await page.waitForTimeout(300);
  await page.keyboard.press("End");
  const per = [];
  for (const ch of " perftest") {
    const before = (await editorText(page)).length;
    const t = Date.now();
    await page.keyboard.type(ch);
    await waitFor(async () => (await editorText(page)).length > before, 3000, 2);
    per.push(Date.now() - t);
  }
  // the in-page measure: time from keydown to next animation frame, for 20 keys
  const frames = await page.evaluate(async () => {
    const out = [];
    const ed = document.querySelector(".cm-content");
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
      document.execCommand("insertText", false, "x");
      await new Promise((r) => requestAnimationFrame(() => r()));
      out.push(Math.round(performance.now() - t));
    }
    return out;
  });
  for (let i = 0; i < 29; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  return { perKeyRoundTripMs: per, insertToFrameMs: frames };
});

await step("All pages view", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/pages`);
  await waitFor(async () => (await page.locator(".all-pages-row").count()) > 10, 20000, 20);
  return { ms: Date.now() - t0, rows: await page.locator(".all-pages-row").count() };
});

await step("journal stream: scroll back 30 screens (infinite scroll)", async () => {
  await page.goto(`${BASE}/journals`);
  await page.waitForFunction(() => !document.body.textContent.includes("Loading…"));
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1000);
  const days = await page.locator(".journal-day").count();
  const last = await page
    .locator(".journal-day h2, .journal-day .journal-day-link")
    .last()
    .textContent()
    .catch(() => "?");
  return { ms: Date.now() - t0, daysRendered: days, last };
});

await page.screenshot({ path: `${OUT}/perf.png` });
console.log("ERRORS:", page.__errs.join("\n"));
console.log(JSON.stringify(results.map((r) => [r.ok ? "PASS" : "FAIL", r.name])));
await browser.close();
