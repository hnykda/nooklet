// Sweep phase 4: search (keyword, Czech diacritics, timing), page delete -> trash -> restore,
// history, assets/images. Usage: OUT=<dir> node .../search-trash.mjs
import {
  api,
  assert,
  BASE,
  launch,
  newPage,
  OUT,
  readBlocks,
  results,
  step,
  waitFor,
} from "./lib.mjs";

const stamp = Date.now().toString(36);
const browser = await launch();
const { page } = await newPage(browser);
await page.goto(`${BASE}/journals`);
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});

async function search(q) {
  await page.goto(`${BASE}/search`);
  const input = page.locator(".search-query-input");
  await input.waitFor();
  const kw = page.locator(".search-mode-toggle button", { hasText: "keyword" });
  if (await kw.count()) await kw.click();
  const t0 = Date.now();
  await input.fill(q);
  await waitFor(
    async () => {
      const s = await page
        .locator(".search-summary")
        .textContent()
        .catch(() => "");
      return (
        /\d+ results?/.test(s) &&
        !(await page
          .locator(".search-loading")
          .isVisible()
          .catch(() => false))
      );
    },
    15000,
    20,
  );
  const ms = Date.now() - t0;
  const summary = await page.locator(".search-summary").textContent();
  const first = await page
    .locator(".search-result")
    .evaluateAll((r) => r.slice(0, 3).map((x) => x.textContent.trim().slice(0, 80)));
  return { q, ms, summary, first };
}

await step("keyword search: English word on real graph", async () => search("kolonizované"));
await step("keyword search: Czech with diacritics 'rekuperaci'", async () => {
  const r = await search("rekuperaci");
  assert(!/^0 /.test(r.summary), JSON.stringify(r));
  return r;
});
await step(
  "keyword search: Czech typed WITHOUT diacritics finds diacritic text ('ríkat' -> 'rikat')",
  async () => {
    const a = await search("říkat");
    const b = await search("rikat");
    assert(!/^0 /.test(b.summary), `with: ${a.summary}, without: ${b.summary}`);
    return { with: a.summary, without: b.summary, ms: [a.ms, b.ms] };
  },
);
await step("keyword search: page title with diacritics 'Plánování'", async () =>
  search("Plánování"),
);
await step("search mode default / semantic configured?", async () => {
  await page.goto(`${BASE}/search`);
  await page.locator(".search-query-input").fill(`zzqq${stamp}`);
  await page.waitForTimeout(2500);
  const note = await page
    .locator(".search-fallback")
    .getAttribute("data-reason")
    .catch(() => null);
  const modes = await page.locator(".search-mode-toggle button").allTextContents();
  return { fallbackReason: note, modes };
});

const DEL = `Sweep Delete Me ${stamp}`;
await step("delete page via Page actions -> Trash -> Restore brings blocks back", async () => {
  await api("page.create", { name: DEL, markdown: "- one\n- two\n  - three" });
  await page.goto(`${BASE}/page/${encodeURIComponent(DEL)}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor();
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 4000 });
  await dialog.getByRole("button", { name: "Delete page" }).click();
  await page.waitForTimeout(1500);
  const gone = await api("page.read", { page: DEL, format: "json" }).then(
    () => "still readable",
    (e) => String(e).slice(0, 80),
  );
  await page.goto(`${BASE}/trash`);
  const row = page.locator(".trash-row", { hasText: DEL });
  await row.waitFor({ timeout: 8000 });
  const meta = await row.locator(".trash-meta").textContent();
  const t0 = Date.now();
  await row.locator(".trash-restore").click();
  await page.locator(".trash-notice").waitFor({ timeout: 8000 });
  const notice = await page.locator(".trash-notice").textContent();
  const restoreMs = Date.now() - t0;
  const b = await waitFor(async () => {
    const x = await readBlocks(DEL).catch(() => []);
    return x.length === 3 ? x : false;
  }, 15000);
  // and the UI page shows them
  await page.goto(`${BASE}/page/${encodeURIComponent(DEL)}`);
  await waitFor(async () => (await page.locator(".vr-outliner .vr-row").count()) === 3, 10000);
  return { gone, meta, notice, restoreMs, blocks: b.map((x) => x.content) };
});

await step("history view of an edited page lists batches and can restore", async () => {
  const H = `Sweep History ${stamp}`;
  await api("page.create", { name: H, markdown: "- v1" });
  const [b] = await readBlocks(H);
  await api("block.update", { id: b.id, content: "v2" });
  await api("block.update", { id: b.id, content: "v3" });
  await page.goto(`${BASE}/history/${encodeURIComponent(H)}`);
  const batches = page.locator(".history-batch");
  await waitFor(async () => (await batches.count()) >= 3, 8000);
  const sums = await batches.locator(".history-summary").allTextContents();
  page.once("dialog", (d) => void d.accept());
  await batches.nth(2).locator(".history-restore").click();
  await page.locator(".history-status").waitFor({ timeout: 5000 });
  const status = await page.locator(".history-status").textContent();
  const after = await waitFor(async () => {
    const c = (await readBlocks(H))[0]?.content;
    return c === "v1" ? c : false;
  }, 8000);
  return { sums, status, after };
});

await step("history of a real imported page opens", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/history/${encodeURIComponent("Balení")}`);
  await waitFor(async () => (await page.locator(".history-batch").count()) > 0, 10000);
  return { ms: Date.now() - t0, batches: await page.locator(".history-batch").count() };
});

await step("imported images render (page '97 poets of Revachol')", async () => {
  await page.goto(`${BASE}/page/${encodeURIComponent("97 poets of Revachol")}`);
  await page.locator(".vr-outliner .vr-row").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(3000);
  const imgs = await page
    .locator(".vr-outliner img")
    .evaluateAll((xs) =>
      xs.map((i) => ({
        src: i.getAttribute("src")?.slice(0, 80),
        w: i.naturalWidth,
        complete: i.complete,
      })),
    );
  assert(imgs.length > 0 && imgs.every((i) => i.w > 0), JSON.stringify(imgs));
  return imgs.slice(0, 3);
});

await step("imported PDF asset link (Stability of Psilocybin...) resolves", async () => {
  const r = await api("search", { query: "Stability of Psilocybin", limit: 3 }).catch((e) =>
    String(e).slice(0, 100),
  );
  return typeof r === "string" ? r : JSON.stringify(r).slice(0, 300);
});

await page.screenshot({ path: `${OUT}/search-trash.png` });
console.log("ERRORS:", page.__errs.join("\n"));
console.log(JSON.stringify(results.map((r) => [r.ok ? "PASS" : "FAIL", r.name])));
await browser.close();
