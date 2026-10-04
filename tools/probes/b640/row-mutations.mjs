// B-640 probe: log every row-level DOM mutation (rows added/removed/moved, content swapped
// between the read view and the editor host) while typing `End, Enter, b, Enter` on a one-block
// page, with the skipped state of each row after each key. Usage: node row-mutations.mjs <baseURL>
import { chromium, webkit } from "@playwright/test";

const [base] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const { token } = await (await fetch(`${base}/api/session`)).json();
const name = `mut ${Date.now() % 100000}`;
await fetch(`${base}/api/v1/page.create`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ name, markdown: "- a" }),
});
page.on("console", (m) => console.log("  ", m.text()));
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForSelector(".vr-outliner .vr-row");
await page.evaluate(() => {
  let n = 0;
  const tag = new WeakMap();
  const id = (el) => {
    if (!tag.has(el)) tag.set(el, `#${++n}`);
    return tag.get(el);
  };
  for (const r of document.querySelectorAll(".vr-row")) id(r);
  const label = (el) =>
    el instanceof HTMLElement
      ? `${el.className.split(" ")[0]}${el.classList.contains("vr-row") ? id(el) : ""}[${el.dataset.blockId ?? ""}]`
      : el.nodeName;
  new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target instanceof HTMLElement ? r.target : null;
      const row = target?.closest(".vr-row");
      for (const a of r.addedNodes)
        if (a instanceof HTMLElement && (a.classList.contains("vr-row") || row))
          console.log(`+ ${label(a)} into ${row ? label(row) : label(target)}`);
      for (const a of r.removedNodes)
        if (a instanceof HTMLElement && (a.classList.contains("vr-row") || row))
          console.log(`- ${label(a)} from ${row ? label(row) : label(target)}`);
    }
  }).observe(document.querySelector(".vr-outliner"), { childList: true, subtree: true });
  window.__rowState = () =>
    [...document.querySelectorAll(".vr-row")]
      .map((r) => {
        const v = r.querySelector(".vr-block-view") ?? r.querySelector(".cm-content");
        return `${id(r)}${v?.checkVisibility({ contentVisibilityAuto: true }) ? "" : " SKIPPED"} ${JSON.stringify(v?.textContent)}`;
      })
      .join(" | ");
});
await page.locator(".vr-block-view", { hasText: "a" }).click();
for (const key of ["End", "Enter", "b", "Enter"]) {
  console.log(`== ${key}`);
  if (key.length === 1) await page.keyboard.type(key);
  else await page.keyboard.press(key);
  await page.waitForTimeout(800);
  console.log(`   state: ${await page.evaluate(() => window.__rowState())}`);
}
await browser.close();
