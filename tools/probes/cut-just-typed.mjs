// Settles: on the real graph, does Cmd+X on a block selection made straight after typing put the
// TYPED text on the clipboard, and does one undo bring the block back with it (B-303, B-245)?
// (2026-09-13, Chromium via @playwright/test, copy of the owner's graph: 952 pages, 18.6k blocks.)
//
// Before B-303's fix, ending an edit re-ran BlockTree's tree effect against the page tree fetched
// before the flushed write, so for as long as the worker took to write and refetch, the row and
// the selection's markdown held the old text. On a big page that refetch is the slow part.
//
// Prints only booleans and counts: the graph is private, its text does not belong in a log.
//
// Run from `e2e/` (so `@playwright/test` resolves) against a running nooklet server on a COPY:
//   BASE=http://127.0.0.1:16403 PAGES="Megapage,2026-05-03" node ../tools/probes/cut-just-typed.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:6188";
const PAGES = (process.env.PAGES ?? "").split(",").filter(Boolean);
const GAPS = (process.env.GAPS ?? "0,150,350").split(",").map(Number);
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await (await fetch(`${BASE}/api/session`)).json();
async function api(op, body) {
  const res = await fetch(`${BASE}/api/v1/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function topLevel(name) {
  const r = await api("page.read", { page: name, format: "json" });
  return r.tree ?? [];
}

const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await context.newPage();

for (const name of PAGES) {
  await page.goto(`${BASE}/page/${encodeURIComponent(name)}`);
  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-row").first().waitFor({ timeout: 60_000 });
  await sleep(2_500); // cold replica: let the bootstrap and first queries finish
  const rows = await outliner.locator(".vr-row").count();
  for (const gap of GAPS) {
    const before = await topLevel(name);
    const marker = `PROBE${gap}X${Date.now().toString(36)}`;
    // Row 0 is a heading on one of the pages; row 1 is an ordinary block (with a child on one).
    await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${marker}`, { delay: 25 });
    await sleep(gap);
    await page.keyboard.press("Escape");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    const t0 = Date.now();
    await page.keyboard.press(`${MOD}+x`);
    let clip = "sentinel";
    for (let i = 0; i < 50 && clip === "sentinel"; i++) {
      await sleep(50);
      clip = await page.evaluate(() => navigator.clipboard.readText());
    }
    const clipMs = Date.now() - t0;
    await sleep(2_000);
    const afterCut = await topLevel(name);
    await page.keyboard.press(`${MOD}+z`);
    await sleep(2_500);
    const afterUndo = await topLevel(name);
    const restored = afterUndo.find((n) => n.content.includes(marker));
    console.log(
      JSON.stringify({
        page: name,
        rows,
        gap,
        clipboardHasTypedText: clip.includes(marker),
        clipboardMs: clipMs,
        clipboardLines: clip.split("\n").length,
        topLevelBefore: before.length,
        topLevelAfterCut: afterCut.length,
        cutRemovedIt: !afterCut.some((n) => n.content.includes(marker)),
        undoRestoredWithTypedText: Boolean(restored),
        topLevelAfterUndo: afterUndo.length,
      }),
    );
    // Leave the graph copy as it was, minus the marker: strip it back out.
    if (restored) {
      await api("block.update", {
        id: restored.id,
        content: restored.content.replace(` ${marker}`, ""),
      }).catch((e) => console.log(`cleanup failed: ${e.message.slice(0, 80)}`));
      await sleep(1_500);
    }
  }
}
await browser.close();
