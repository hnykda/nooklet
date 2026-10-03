// Sweep diag: typing into TODAY's virtual journal draft and pressing Enter / Tab.
// Deletes today's journal page through the API first so today is virtual again, then opens a fresh
// browser context (empty replica, like a first launch or a new device) and types.
// Usage: OUT=<dir> node .../draft-diag.mjs <waitMsBeforeTyping> <delayPerKeyMs>
import {
  api,
  BASE,
  isoToday,
  launch,
  newPage,
  OUT,
  readBlocks,
  rowDepths,
  rowTexts,
} from "./lib.mjs";

const wait = Number(process.argv[2] ?? 0);
const delay = Number(process.argv[3] ?? 0);
const today = isoToday();
// page.delete refuses journals ("cleared automatically when emptied"), so delete the blocks.
try {
  for (const b of await readBlocks(today))
    if (b.depth === 0) await api("block.delete", { id: b.id });
} catch (e) {
  console.log("clear:", String(e).slice(0, 120));
}

const browser = await launch();
const { page } = await newPage(browser);
const day = page.locator(".journal-day-today");
await page.goto(`${BASE}/journals`);
await day.locator(".vr-draft-input, .vr-row").first().waitFor();
if (wait) await page.waitForTimeout(wait);
const snap = async (label) => {
  const outl = day.locator(".vr-outliner");
  const ui = (await outl.count()) ? await rowTexts(outl) : ["<no outliner>"];
  const d = (await outl.count()) ? await rowDepths(outl) : [];
  const draft = await day.locator(".vr-draft-input").count();
  const active = await page.evaluate(() =>
    `${document.activeElement?.tagName}.${document.activeElement?.className}`.slice(0, 60),
  );
  let server = [];
  try {
    server = (await readBlocks(today)).map((b) => `${"  ".repeat(b.depth)}${b.content}`);
  } catch {}
  console.log(
    `${label.padEnd(22)} ui=${JSON.stringify(ui)} depth=${JSON.stringify(d)} draft=${draft} focus=${active} server=${JSON.stringify(server)}`,
  );
};
await snap("loaded");
await day.locator(".vr-draft-input, .vr-row").first().click();
await page.keyboard.type("sweep one", { delay });
await snap("typed one");
await page.keyboard.press("Enter");
await page.waitForTimeout(delay * 5);
await snap("Enter");
await page.keyboard.type("sweep two", { delay });
await snap("typed two");
await page.keyboard.press("Tab");
await page.waitForTimeout(delay * 5);
await snap("Tab");
await page.keyboard.press("Enter");
await page.keyboard.type("sweep three", { delay });
await snap("Enter+three");
await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(2000);
await snap("Shift+Tab (+2s)");
await page.waitForTimeout(5000);
await snap("+5s");
await page.screenshot({ path: `${OUT}/draft-${wait}-${delay}.png` });
console.log("ERRORS:", page.__errs.join("\n"));
await browser.close();
