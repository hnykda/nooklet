// B-640 probe: drive remote changes at an open page in WebKit (the engine of both the Mac app and
// the iPhone app) and measure whether each row actually PAINTS — by screenshotting the row and
// counting ink pixels — rather than trusting the DOM, which held the right text all along.
// Usage: ENGINE=webkit|chromium SCENARIO=<name> node scenarios.mjs <baseURL> <outdir>
import { chromium, webkit } from "@playwright/test";

const [base, out] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await ctx.newPage();
const inkPage = await ctx.newPage();
const { token } = await (await fetch(`${base}/api/session`)).json();
const api = async (op, body) => {
  const r = await fetch(`${base}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${op} ${r.status} ${await r.text()}`);
  return r.json();
};
async function ink(buf) {
  return inkPage.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g2 = c.getContext("2d");
    g2.drawImage(img, 0, 0);
    const d = g2.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) n++;
    return n;
  }, buf.toString("base64"));
}
async function report(label) {
  await page.waitForTimeout(1200);
  const rows = page.locator(".vr-outliner").first().locator(".vr-row");
  const n = await rows.count();
  const lines = [];
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    const text = await r.evaluate(
      (e) => e.querySelector(".vr-block-view")?.textContent ?? "<edit>",
    );
    const px = await ink(await r.screenshot());
    if (px === 0) bad++;
    lines.push(`  ${px === 0 ? "BLANK" : "ok   "} ink=${px} ${JSON.stringify(text.slice(0, 30))}`);
  }
  console.log(`--- ${label}${bad ? `  (${bad} blank)` : ""}\n${lines.join("\n")}`);
  await page.screenshot({ path: `${out}/${label}.png` });
  return bad;
}

const scenario = process.env.SCENARIO ?? "mac";
const name = `b640 ${scenario} ${Date.now()}`;
const ids = async () =>
  [...(await api("page.read", { page: name })).text.matchAll(/^(\s*)- (.*?) ?\^(\w{14})$/gm)].map(
    (m) => ({ depth: m[1].length / 2, text: m[2], id: m[3] }),
  );
await api("page.create", { name, markdown: "- One\n- Three\n  - Nested\n  - Desktop" });
await page.goto(`${base}/page/${encodeURIComponent(name)}`);
await page.waitForSelector(".vr-outliner .vr-row");
await report("0-initial");
if (scenario === "phone") {
  // Another device made an empty row; this device (the phone) types into it, Enter, Tab, types.
  const desk = (await ids()).find((b) => b.text === "Desktop");
  await api("block.insert", { ref: desk.id, position: "after", markdown: "- x" });
  const x = (await ids()).find((b) => b.text === "x");
  await api("block.update", { id: x.id, content: "" });
  await api("block.move", { id: x.id, page: name });
  await report("1-remote-empty-row");
  const rows = page.locator(".vr-outliner .vr-row");
  await rows
    .nth((await rows.count()) - 1)
    .locator(".vr-block-view")
    .click();
  await page.keyboard.type("Ok these ones are added on mobile", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Nothing", { delay: 20 });
  await page.waitForTimeout(700);
  await report("2-typed");
  await page.keyboard.press("Escape");
  await report("3-escaped");
  await browser.close();
  process.exit(0);
}
// This device (the Mac): Enter at the end of "Desktop", Shift+Tab, then leave the row.
await page.locator(".vr-row").nth(3).locator(".vr-block-view").click();
await page.keyboard.press("End");
await page.keyboard.press("Enter");
if (scenario !== "noouthent") await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(800);
if (process.env.LEAVE === "escape") await page.keyboard.press("Escape");
await report("1-local-empty-row");
const fresh = (await ids()).find((b) => b.text === "");
console.log("fresh", fresh);
// The other device (the phone): types into that row, Enter, Tab, types.
await api("block.update", { id: fresh.id, content: "Ok these ones are added on mobile" });
await report("2-remote-text");
await api("block.insert", { ref: fresh.id, position: "child_last", markdown: "- Nothing" });
await report("3-remote-child");
await api("block.insert", {
  ref: fresh.id,
  position: "child_last",
  markdown: "- And that\n- ".replace("- \n", ""),
});
await report("4-remote-child2");
await browser.close();
