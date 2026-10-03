// Sweep phase 5: two browser contexts on the same graph — live sync both ways, then one context
// offline (network emulation + route block), edits on both sides, reconnect, converge.
// Usage: OUT=<dir> node .../sync.mjs
import {
  api,
  assert,
  BASE,
  launch,
  newPage,
  OUT,
  readBlocks,
  results,
  rowTexts,
  step,
  waitFor,
} from "./lib.mjs";

const stamp = Date.now().toString(36);
const P = `Sweep Sync ${stamp}`;
await api("page.create", { name: P, markdown: "- alpha\n- beta\n- gamma" });
const browser = await launch();
const A = await newPage(browser, "A");
const B = await newPage(browser, "B");
for (const { page } of [A, B]) {
  await page.goto(`${BASE}/page/${encodeURIComponent(P)}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
    timeout: 30000,
  });
}
const outl = (p) => p.locator(".vr-outliner").first();
const syncLabel = (p) =>
  p.evaluate(
    () =>
      document
        .querySelector(".sync-indicator, [class*='sync-indicator']")
        ?.getAttribute("aria-label") ?? null,
  );

async function editRow(p, i, append) {
  const row = outl(p).locator(".vr-row").nth(i);
  const b = await row.boundingBox();
  await p.mouse.click(b.x + b.width - 6, b.y + 10);
  await p.waitForTimeout(150);
  await p.keyboard.press("End");
  await p.keyboard.type(append, { delay: 10 });
  await p.keyboard.press("Escape");
}

await step("live: A types, B sees it", async () => {
  const t0 = Date.now();
  await editRow(A.page, 0, " fromA");
  await waitFor(async () => (await rowTexts(outl(B.page)))[0] === "alpha fromA", 15000, 50);
  return { ms: Date.now() - t0 };
});

await step("live: B adds a block, A sees it", async () => {
  const row = outl(B.page).locator(".vr-row").nth(2);
  const b = await row.boundingBox();
  await B.page.mouse.click(b.x + b.width - 6, b.y + 10);
  await B.page.keyboard.press("End");
  await B.page.keyboard.press("Enter");
  const t0 = Date.now();
  await B.page.keyboard.type("delta fromB", { delay: 10 });
  await B.page.keyboard.press("Escape");
  await waitFor(async () => (await rowTexts(outl(A.page))).includes("delta fromB"), 15000, 50);
  return { ms: Date.now() - t0, a: await rowTexts(outl(A.page)) };
});

await step("offline A edits + online B edits, reconnect, both converge with server", async () => {
  await A.ctx.setOffline(true);
  await A.ctx.route("**/*", (r) => r.abort());
  await A.page.waitForTimeout(3000);
  const labelOff = await syncLabel(A.page);
  await editRow(A.page, 1, " offlineA");
  await editRow(B.page, 2, " onlineB");
  await A.page.waitForTimeout(1500);
  const serverWhileOff = (await readBlocks(P)).map((b) => b.content);
  // reload while offline? (no: only check in-memory/OPFS pending queue survives the reconnect)
  await A.ctx.unroute("**/*");
  await A.ctx.setOffline(false);
  const t0 = Date.now();
  const want = ["alpha fromA", "beta offlineA", "gamma onlineB", "delta fromB"];
  await waitFor(
    async () =>
      JSON.stringify((await readBlocks(P)).map((b) => b.content)) === JSON.stringify(want),
    30000,
    200,
  );
  const serverMs = Date.now() - t0;
  await waitFor(
    async () => JSON.stringify(await rowTexts(outl(A.page))) === JSON.stringify(want),
    30000,
    200,
  );
  await waitFor(
    async () => JSON.stringify(await rowTexts(outl(B.page))) === JSON.stringify(want),
    30000,
    200,
  );
  return {
    labelOff,
    serverWhileOff,
    convergedMs: Date.now() - t0,
    serverMs,
    labelAfter: await syncLabel(A.page),
  };
});

await step("offline edit survives a reload while still offline, then syncs", async () => {
  await A.ctx.setOffline(true);
  await A.ctx.route("**/*", (r) => r.abort());
  await A.page.waitForTimeout(1500);
  await editRow(A.page, 3, " persisted-offline");
  await A.page.waitForTimeout(1500);
  let reloadOk = "n/a";
  try {
    await A.page.reload({ timeout: 15000 });
    await A.page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 15000 });
    reloadOk = JSON.stringify(await rowTexts(outl(A.page)));
  } catch (e) {
    reloadOk = `reload offline failed: ${String(e.message).slice(0, 120)}`;
  }
  await A.ctx.unroute("**/*");
  await A.ctx.setOffline(false);
  if (reloadOk.startsWith("reload offline failed")) {
    await A.page.goto(`${BASE}/page/${encodeURIComponent(P)}`);
  }
  await waitFor(
    async () => (await readBlocks(P)).some((b) => b.content === "delta fromB persisted-offline"),
    30000,
    200,
  );
  return { reloadOk };
});

await step(
  "same-block conflict: A offline and B online both edit 'alpha'; LWW, both converge",
  async () => {
    await A.ctx.setOffline(true);
    await A.ctx.route("**/*", (r) => r.abort());
    await A.page.waitForTimeout(1000);
    await editRow(A.page, 0, " A-offline");
    await A.page.waitForTimeout(500);
    await editRow(B.page, 0, " B-online");
    await B.page.waitForTimeout(1500);
    await A.ctx.unroute("**/*");
    await A.ctx.setOffline(false);
    await A.page.waitForTimeout(8000);
    const s = (await readBlocks(P))[0].content;
    const a = (await rowTexts(outl(A.page)))[0];
    const b = (await rowTexts(outl(B.page)))[0];
    assert(a === s && b === s, `server ${s} A ${a} B ${b}`);
    return { server: s };
  },
);

await A.page.screenshot({ path: `${OUT}/sync-A.png` });
console.log(
  "ERRORS:",
  A.page.__errs
    .concat(B.page.__errs)
    .filter((e) => !e.includes("ERR_INTERNET_DISCONNECTED") && !e.includes("net::"))
    .join("\n"),
);
console.log(JSON.stringify(results.map((r) => [r.ok ? "PASS" : "FAIL", r.name])));
await browser.close();
