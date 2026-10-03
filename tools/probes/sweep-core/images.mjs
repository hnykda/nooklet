// Sweep diag: do imported images render? Opens pages that embed imported image assets, scrolls the
// whole outline (it is virtualized), and reports every <img> with its natural size.
// Usage: OUT=<dir> node .../images.mjs <page> [<page> ...]
import { api, BASE, launch, newPage, OUT } from "./lib.mjs";

const browser = await launch();
const { page } = await newPage(browser);
const bad = [];
page.on("response", (r) => {
  if (r.url().includes("/assets/") && r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
});
for (const name of process.argv.slice(2)) {
  const tree = (await api("page.read", { page: name, format: "json" })).tree;
  const flat = [];
  const walk = (ns, d, hidden) => {
    for (const n of ns ?? []) {
      flat.push({ d, c: n.content.slice(0, 70), collapsed: n.collapsed, hidden });
      walk(n.children, d + 1, hidden || n.collapsed);
    }
  };
  walk(tree, 0, false);
  const withImg = flat.filter((b) => b.c.includes("!["));
  await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 15000 });
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  const imgs = await page
    .locator("img")
    .evaluateAll((xs) =>
      xs.map((i) => ({ src: (i.getAttribute("src") ?? "").slice(0, 90), w: i.naturalWidth })),
    );
  console.log(name, JSON.stringify({ blocksWithImageMarkdown: withImg, imgs }));
  await page.screenshot({ path: `${OUT}/images-${name.replace(/\W+/g, "_")}.png` });
}
console.log("asset HTTP errors:", bad);
console.log("ERRORS:", page.__errs.join("\n"));
await browser.close();
