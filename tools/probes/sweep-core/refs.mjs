// Sweep phase 2: [[refs]] and #tags — autocomplete, page creation, navigation, linked/unlinked
// references, rename rewriting links. All on the real imported graph.
// Usage: OUT=<dir> node .../refs.mjs
import {
  api,
  assert,
  BASE,
  editorText,
  launch,
  newPage,
  OUT,
  readBlocks,
  results,
  step,
  waitFor,
} from "./lib.mjs";

const stamp = Date.now().toString(36);
const SRC = `Sweep Refs Source ${stamp}`;
const NEW = `Sweep Nová Stránka ${stamp}`;
const TAG = `sweeptag${stamp}`;
const browser = await launch();
const { page } = await newPage(browser);
await api("page.create", { name: SRC, markdown: "- start" });
// A plain-text mention of an existing Czech page, for unlinked references.
await api("page.append", { page: SRC, markdown: "- zmínka o Balení bez odkazu" });

const content = async () => (await readBlocks(SRC))[0]?.content;
const popupRows = async () =>
  page.locator(".cmd-popup .cmd-row").evaluateAll((r) => r.map((x) => x.textContent.trim()));

await page.goto(`${BASE}/page/${encodeURIComponent(SRC)}`);
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});
const outl = page.locator(".vr-outliner").first();

await step("[[ autocomplete offers 'New page' and creates the page", async () => {
  await outl.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  const t0 = Date.now();
  await page.keyboard.type(" see [[");
  await page.locator(".cmd-popup").first().waitFor({ timeout: 5000 });
  const popupMs = Date.now() - t0;
  await page.keyboard.type(NEW, { delay: 15 });
  await page.waitForTimeout(600);
  const rows = await popupRows();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const ed = await editorText(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  const c = await content();
  const pg = await api("page.read", { page: NEW, format: "json" }).catch((e) => String(e));
  assert(
    c === `start see [[${NEW}]]`,
    `server content ${JSON.stringify(c)}; editor was ${JSON.stringify(ed)}; rows ${JSON.stringify(rows)}`,
  );
  assert(typeof pg === "object", `new page not readable: ${pg}`);
  return { popupMs, rows: rows.slice(0, 4), ed };
});

await step(
  "[[ autocomplete finds an existing Czech page by prefix without diacritics",
  async () => {
    await outl.locator(".vr-block-view").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and [[Balen", { delay: 15 });
    await page.waitForTimeout(800);
    const rows = await popupRows();
    const rows2 = rows;
    // also: without diacritics
    for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("Baleni", { delay: 15 });
    await page.waitForTimeout(800);
    const rowsNoDia = await popupRows();
    // pick the Balení row
    const idx = rowsNoDia.findIndex((r) => r.startsWith("Balení"));
    const idxDia = rows2.findIndex((r) => r.startsWith("Balení"));
    if (idx >= 0) {
      for (let i = 0; i < idx; i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    const c = await content();
    assert(idxDia >= 0, `"Balen" did not offer Balení: ${JSON.stringify(rows2)}`);
    assert(idx >= 0, `"Baleni" (no diacritics) did not offer Balení: ${JSON.stringify(rowsNoDia)}`);
    assert(c.endsWith("[[Balení]]"), `content ${JSON.stringify(c)}`);
    return { rows: rows2.slice(0, 3), rowsNoDia: rowsNoDia.slice(0, 3) };
  },
);

await step("#tag typed with autocomplete creates a tag page", async () => {
  await outl.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(` #${TAG}`, { delay: 15 });
  await page.waitForTimeout(500);
  const rows = await popupRows();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  const c = await content();
  const pg = await api("page.read", { page: TAG, format: "json" }).catch((e) => String(e));
  assert(c.endsWith(`#${TAG}`), `content ${JSON.stringify(c)}`);
  assert(typeof pg === "object", `tag page not readable: ${pg}`);
  return { rows: rows.slice(0, 3), c };
});

await step("click a [[ref]] navigates; target shows linked reference back", async () => {
  await page.keyboard.press("Escape");
  const link = outl.locator(".vr-page-ref", { hasText: NEW }).first();
  await link.click();
  await waitFor(async () => decodeURIComponent(page.url()).includes(NEW), 5000);
  const linked = page.locator(".linked-references");
  await linked.waitFor({ timeout: 8000 });
  const txt = await linked.textContent();
  assert(txt.includes("Sweep Refs Source"), `linked refs: ${txt.slice(0, 200)}`);
  return txt.slice(0, 120);
});

await step("existing heavily-linked page (Balení) shows linked + unlinked refs", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/page/${encodeURIComponent("Balení")}`);
  await page.locator(".linked-references").waitFor({ timeout: 15000 });
  const ms = Date.now() - t0;
  const linked = await page.locator(".linked-references .reference-count").first().textContent();
  const un = page.locator(".unlinked-references");
  let unCount = null;
  if (await un.count()) unCount = await un.locator(".reference-count").first().textContent();
  assert(unCount !== null && Number(unCount) >= 1, `unlinked count ${unCount}`);
  return { linked, unCount, ms };
});

await step("rename page from title rewrites links in the source block", async () => {
  await page.goto(`${BASE}/page/${encodeURIComponent(NEW)}`);
  const title = page.locator(".page-title-input");
  await title.waitFor({ timeout: 8000 });
  const RENAMED = `${NEW} přejmenováno`;
  page.once("dialog", (d) => void d.accept());
  await title.fill(RENAMED);
  await title.press("Enter");
  await page.waitForTimeout(2500);
  const c = await content();
  assert(c.includes(`[[${RENAMED}]]`), `source after rename ${JSON.stringify(c)}`);
  // and the UI on the source page shows the new name
  await page.goto(`${BASE}/page/${encodeURIComponent(SRC)}`);
  await page.locator(".vr-page-ref", { hasText: RENAMED }).first().waitFor({ timeout: 8000 });
  return { c, url: decodeURIComponent(page.url()) };
});

await step("old name still resolves (alias) after rename", async () => {
  await page.goto(`${BASE}/page/${encodeURIComponent(NEW)}`);
  await page.waitForTimeout(2500);
  const t = await page
    .locator(".page-title-input")
    .inputValue()
    .catch(() => null);
  const missing = await page.locator(".page-view-missing").count();
  return { title: t, missing, url: decodeURIComponent(page.url()) };
});

await page.screenshot({ path: `${OUT}/refs.png` });
console.log("ERRORS:", page.__errs.join("\n"));
console.log(JSON.stringify(results.map((r) => [r.ok ? "PASS" : "FAIL", r.name])));
await browser.close();
