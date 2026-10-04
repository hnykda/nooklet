// B-640 probe: open "phone test" in a real engine, then move the "Ok these ones…" block around
// through the API (as another device would) and report, after each live refresh, whether each
// row's content is rendered (checkVisibility with contentVisibilityAuto) and screenshot the page.
// Usage: ENGINE=webkit|chromium node live-move.mjs <baseURL> <outdir>
import { chromium, webkit } from "@playwright/test";

const [base, out] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const page = await browser.newPage();
const { token } = await (await fetch(`${base}/api/session`)).json();
const api = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ dry_run: false, ...body }),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
};
const dump = async (label) => {
  await page.waitForTimeout(1500);
  const rows = await page.locator(".vr-outliner .vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const v = r.querySelector(".vr-block-view");
      return `${r.style.getPropertyValue("--depth")} vis=${v?.checkVisibility?.({ contentVisibilityAuto: true })} h=${Math.round(r.getBoundingClientRect().height)} ${JSON.stringify(v?.textContent?.slice(0, 30))}`;
    }),
  );
  console.log(`--- ${label}\n${rows.join("\n")}`);
  await page.screenshot({ path: `${out}/${label}.png` });
};
await page.goto(`${base}/page/${encodeURIComponent("phone test")}`);
await page.waitForSelector(".vr-outliner .vr-row");
await dump("0-initial");
const B = "1m431z65as6tgd";
await api("block.move", { id: B, page: "phone test" });
await dump("1-moved-top");
await api("block.move", { id: B, ref: "1m431ygjm5447r", position: "after" });
await dump("2-moved-back");
await browser.close();
