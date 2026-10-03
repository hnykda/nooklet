// Sweep diag: after "a" Enter "b" Tab Enter "c" Shift-Tab on a fresh page, does the outline show
// all three rows right away? Polls the rendered rows every 50 ms for 3 s after each key.
// Usage: OUT=<dir> node .../indent-render.mjs [journal|page]
import {
  api,
  BASE,
  editorText,
  isoToday,
  launch,
  newPage,
  OUT,
  readBlocks,
  rowDepths,
  rowTexts,
} from "./lib.mjs";

const where = process.argv[2] ?? "page";
const fast = process.argv[3] === "fast"; // no pauses between keys: a fast typist
const keyDelay = Number(process.argv[4] ?? 0); // with "fast": ms between every keystroke (human-ish: 60-120)
const browser = await launch();
const { page } = await newPage(browser);
let scope;
const name = `Sweep Indent ${Date.now()}`;
if (where === "journal") {
  const today = isoToday();
  for (const b of await readBlocks(today).catch(() => []))
    if (b.depth === 0) await api("block.delete", { id: b.id });
  await page.goto(`${BASE}/journals`);
  scope = page.locator(".journal-day-today");
} else {
  await api("page.create", { name, markdown: "- " });
  await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
  scope = page.locator(".vr-outliner").first();
}
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});
await page.waitForTimeout(500);
await scope.locator(".vr-row").first().click();
const trace = async (label, ms = 1500) => {
  const t0 = Date.now();
  let last = "";
  if (fast && !label.startsWith("Shift")) return;
  if (fast) ms = 6000;
  while (Date.now() - t0 < ms) {
    const s = JSON.stringify([await rowTexts(scope), await rowDepths(scope)]);
    if (s !== last)
      console.log(`${label.padEnd(10)} +${String(Date.now() - t0).padStart(4)}ms ${s}`);
    last = s;
    await page.waitForTimeout(50);
  }
};
await page.keyboard.type("aaa", { delay: keyDelay });
await page.waitForTimeout(keyDelay);
await trace("type a", 300);
await page.keyboard.press("Enter");
await page.waitForTimeout(keyDelay);
await trace("Enter", 600);
await page.keyboard.type("bbb", { delay: keyDelay });
await page.waitForTimeout(keyDelay);
await trace("type b", 300);
await page.keyboard.press("Tab");
await page.waitForTimeout(keyDelay);
await trace("Tab", 1000);
await page.keyboard.press("Enter");
await page.waitForTimeout(keyDelay);
await trace("Enter", 1000);
await page.keyboard.type("ccc", { delay: keyDelay });
await page.waitForTimeout(keyDelay);
await trace("type c", 600);
await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(keyDelay);
await trace("Shift+Tab", 3000);
console.log("editor:", JSON.stringify(await editorText(page)));
await page.waitForTimeout(1500);
const serverName = where === "journal" ? isoToday() : name;
console.log(
  "server:",
  JSON.stringify((await readBlocks(serverName)).map((b) => `${"  ".repeat(b.depth)}${b.content}`)),
);
await page.screenshot({ path: `${OUT}/indent-render-${where}.png` });
console.log("ERRORS:", page.__errs.join("\n"));
await browser.close();
