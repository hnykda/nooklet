// B-640 probe: replay the test graph's real session with two browser contexts — "mac" and
// "phone" — typing the same keys the op log records, with the phone going offline for its part,
// then check every row on both for content that is in the DOM but not rendered.
// Usage: ENGINE=webkit|chromium node two-devices.mjs <baseURL> <outdir>
import { chromium, devices, webkit } from "@playwright/test";

const [base, out] = process.argv.slice(2);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch();
const mac = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const phoneCtx = await browser.newContext(
  process.env.PHONE_DESKTOP ? { viewport: { width: 400, height: 800 } } : devices["iPhone 13"],
);
const phone = await phoneCtx.newPage();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = `two ${Date.now() % 100000}`;
await api("page.create", {
  name,
  markdown: "- One\n- Two\n- Three\n  - Nested\n  - I added this one on desktop",
});
for (const p of [mac, phone]) {
  await p.goto(`${base}/page/${encodeURIComponent(name)}`);
  await p.waitForSelector(".vr-outliner .vr-row");
  // NOCV=1: the same run with content-visibility switched off, to test it as the cause.
  if (process.env.NOCV)
    await p.addStyleTag({ content: ".vr-row { content-visibility: visible !important; }" });
}
const row = (p, text) =>
  p.locator(".vr-outliner .vr-row").filter({ has: p.locator(".vr-block-view", { hasText: text }) });
const lastRow = (p) => p.locator(".vr-outliner .vr-row").last();
const tap = async (p, loc) => {
  if (p === phone) await loc.locator(".vr-block-view").tap();
  else await loc.locator(".vr-block-view").click();
  await p.locator(".cm-content").waitFor();
};
async function report(label) {
  for (const [who, p] of [
    ["mac", mac],
    ["phone", phone],
  ]) {
    const rows = await p.locator(".vr-outliner .vr-row").evaluateAll((rows) =>
      rows.map((r) => {
        const v = r.querySelector(".vr-block-view") ?? r.querySelector(".cm-content");
        const b = r.querySelector(".vr-bullet");
        const vis = v?.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true });
        const bvis = b?.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true });
        const rect = r.getBoundingClientRect();
        // Hidden only by content-visibility (skipped), or by something else as well?
        if (!(vis && bvis) && v?.checkVisibility({ opacityProperty: true }))
          return `CV-SKIPPED d=${r.style.getPropertyValue("--depth")} ${JSON.stringify((v?.textContent ?? "?").slice(0, 28))}`;
        return `${vis && bvis ? "ok " : "HID"} d=${r.style.getPropertyValue("--depth")} h=${Math.round(rect.height)} ${JSON.stringify((v?.textContent ?? "?").slice(0, 28))}`;
      }),
    );
    console.log(`--- ${label} [${who}]\n  ${rows.join("\n  ")}`);
    await p.screenshot({ path: `${out}/two-${label}-${who}.png` });
  }
}

// Mac: Enter after "I added…" (an empty row under Three), Shift+Tab (top level), leave it.
await tap(mac, row(mac, "I added this one"));
await mac.keyboard.press("End");
await mac.keyboard.press("Enter");
await mac.keyboard.press("Shift+Tab");
await sleep(1500);
await mac.keyboard.press("Escape");
await sleep(1500);
await report("1-mac-empty-row");
// Phone (online): types into that row, Enter, Tab, types.
await tap(phone, lastRow(phone));
await phone.keyboard.type("Ok these ones are added on mobile in airplane mode", { delay: 15 });
await phone.keyboard.press("Enter");
await phone.keyboard.press("Tab");
await phone.keyboard.type("Nothing ", { delay: 15 });
await sleep(2000);
await report("2-phone-typed-online");
// Phone goes offline and keeps typing in the "Nothing " row.
await phoneCtx.setOffline(true);
await sleep(500);
await phone.keyboard.press("ControlOrMeta+a");
await phone.keyboard.type("There is this", { delay: 15 });
await phone.keyboard.press("Enter");
await phone.keyboard.type("And that", { delay: 15 });
await phone.keyboard.press("Enter");
await sleep(1500);
// Mac meanwhile: edits "Nothing " to "Nothing", Enter, Shift+Tab, types, Enter.
await tap(mac, row(mac, "Nothing"));
await mac.keyboard.press("End");
await mac.keyboard.press("Backspace");
await mac.keyboard.press("Enter");
await mac.keyboard.press("Shift+Tab");
await mac.keyboard.type("well and here I am adding something on mac", { delay: 15 });
await mac.keyboard.press("Enter");
await sleep(1500);
await mac.keyboard.press("Escape");
await phone.keyboard.press("Escape");
await sleep(1500);
await report("3-offline-split");
await phoneCtx.setOffline(false);
await sleep(8000);
await report("4-reconnected");
await browser.close();
