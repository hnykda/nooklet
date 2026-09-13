/**
 * B-536: does a REAL Cmd+V paste into the block editor? A plain <textarea> is the control.
 *   cd e2e && BASE=http://127.0.0.1:6491 node ../tools/probes/keyboard-paste-chromium.cjs
 * against any running `nooklet serve` whose graph you may write a "probe chromium paste2 …" page to.
 * Result 2026-09-13 before the fix: control "PASTED"; block "hello " with the V keydown
 * defaultPrevented after the command dispatcher. After: e2e/tests/keyboard-paste.spec.ts passes.
 */
const { chromium } = require("@playwright/test");
const BASE = process.env.BASE ?? "http://127.0.0.1:6491";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/journals`);
  await page.locator(".app-topbar").waitFor();
  await page.evaluate(() => {
    const t = document.createElement("textarea");
    t.id = "ctl";
    t.style.cssText = "position:fixed;top:200px;left:200px;z-index:99999";
    document.body.append(t);
  });
  await page.locator("#ctl").click();
  await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
  await page.keyboard.press("Meta+V");
  await page.waitForTimeout(500);
  console.log(
    "control textarea after Meta+V:",
    JSON.stringify(await page.locator("#ctl").inputValue()),
  );
  // block editor with the dispatcher's preventDefault observed at the end of propagation
  await page.goto(`${BASE}/page/${encodeURIComponent(`probe chromium paste2 ${Date.now()}`)}`);
  await page.locator(".page-view-missing button").click();
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("hello ");
  await page.evaluate(() => {
    window.__ev = [];
    document.addEventListener("paste", () => window.__ev.push("paste"), true);
    window.addEventListener(
      "keydown",
      (_e) => {
        setTimeout(() => {}, 0);
      },
      true,
    );
    document
      .querySelector(".cm-content")
      .addEventListener("keydown", (e) => window.__ev.push(["cm keydown", e.key]), true);
    document.addEventListener(
      "keydown",
      (e) =>
        queueMicrotask(() =>
          window.__ev.push(["doc keydown after dispatch", e.key, e.defaultPrevented]),
        ),
      true,
    );
  });
  await page.keyboard.press("Meta+V");
  await page.waitForTimeout(800);
  console.log(
    "block editor after Meta+V:",
    await page.locator(".vr-row").first().textContent(),
    JSON.stringify(await page.evaluate(() => window.__ev)),
  );
  await browser.close();
})();
