// Sweep diag: where does End put the caret in a block that ENDS with a [[link]]?
// Seeds blocks ending in a link, clicks each (at its start), presses End, types "Z".
// Usage: node .../end-after-link.mjs
import { api, BASE, editorText, launch, newPage, readBlocks } from "./lib.mjs";

const name = `Sweep End Link ${Date.now().toString(36)}`;
await api("page.create", {
  name,
  markdown:
    "- plain text [[Balení]]\n- short [[Inbox]]\n- no link at end\n- [[Inbox]] trailing words\n- text **bold** end",
});
const browser = await launch();
const { page } = await newPage(browser);
await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});
const outl = page.locator(".vr-outliner").first();
for (let i = 0; i < 5; i++) {
  const view = outl.locator(".vr-row").nth(i).locator(".vr-block-view");
  // Enter edit mode from the empty space right of the text (x=3 would follow a leading link),
  // then Home, End: the End key alone decides where the caret goes.
  const vb = await view.boundingBox();
  await page.mouse.click(vb.x + vb.width - 4, vb.y + vb.height / 2);
  await page.waitForTimeout(200);
  await page.keyboard.press("Home");
  const before = await page.evaluate(() => getSelection()?.anchorOffset);
  await page.keyboard.press("End");
  await page.keyboard.type("Z");
  await page.waitForTimeout(200);
  console.log(
    i,
    "anchorOffsetAfterClick",
    before,
    "editor:",
    JSON.stringify(await editorText(page)),
  );
  await page.keyboard.press("Escape");
}
await page.waitForTimeout(1500);
console.log("server:", JSON.stringify((await readBlocks(name)).map((b) => b.content)));
// Variant: click in the empty space to the right of the text (how a person reaches the end of a
// line with the mouse), then type — no End key involved.
for (let i = 0; i < 5; i++) {
  const view = outl.locator(".vr-row").nth(i).locator(".vr-block-view");
  const box = await view.boundingBox();
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.waitForTimeout(200);
  await page.keyboard.type("Y");
  await page.waitForTimeout(200);
  console.log(i, "click-right-of-text editor:", JSON.stringify(await editorText(page)));
  await page.keyboard.press("Escape");
}
// Variant: click on the link's own last character area (right edge of the rendered link)? skipped:
// that follows the link.
await page.waitForTimeout(1500);
console.log("server:", JSON.stringify((await readBlocks(name)).map((b) => b.content)));
const junk = await api("page.read", { page: "BaleníZ", format: "json" }).then(
  () => "EXISTS",
  (e) => String(e).slice(0, 80),
);
console.log('page "BaleníZ":', junk);
await browser.close();
