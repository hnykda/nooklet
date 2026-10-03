// Sweep phase 3: tasks (cycle, LATER/NOW, scheduled), tasks view, properties, query fence,
// templates, slash menu, command palette. Usage: OUT=<dir> node .../tasks.mjs
import {
  api,
  assert,
  BASE,
  editorText,
  launch,
  MOD,
  newPage,
  OUT,
  readBlocks,
  results,
  step,
  waitFor,
} from "./lib.mjs";

const stamp = Date.now().toString(36);
const P = `Sweep Tasks ${stamp}`;
await api("page.create", {
  name: P,
  markdown: `- cycle me ${stamp}\n- LATER owner style ${stamp}\n- prop host ${stamp}\n- `,
});
const browser = await launch();
const { page } = await newPage(browser);
await page.goto(`${BASE}/page/${encodeURIComponent(P)}`);
await page.waitForFunction(() => !document.body.textContent.includes("Loading…"), null, {
  timeout: 30000,
});
const outl = page.locator(".vr-outliner").first();
const row = (i) => outl.locator(".vr-row").nth(i);
const enter = async (i) => {
  const b = await row(i).boundingBox();
  await page.mouse.click(b.x + b.width - 6, b.y + 10);
  await page.waitForTimeout(150);
};
const blocks = async () => readBlocks(P);
// The marker is its own field, not part of `content`.
const markers = async () =>
  (await api("page.read", { page: P, format: "json" })).tree.map((n) => n.marker);

await step("Mod+Enter cycles null -> TODO -> DOING -> DONE -> null", async () => {
  await enter(0);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForTimeout(700);
    seen.push((await markers())[0]);
  }
  assert(
    JSON.stringify(seen) === JSON.stringify(["TODO", "DOING", "DONE", null]),
    JSON.stringify(seen),
  );
  return seen;
});

await step(
  "Mod+Enter on an owner-style LATER task (graph uses :preferred-workflow :now)",
  async () => {
    await page.keyboard.press("Escape");
    await enter(1);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press(`${MOD}+Enter`);
      await page.waitForTimeout(700);
      seen.push((await markers())[1]);
    }
    // Logseq with :preferred-workflow :now: LATER -> NOW -> DONE.
    assert(
      seen[0] === "NOW",
      `LATER cycled to ${JSON.stringify(seen)} (Logseq :now workflow: NOW, DONE, ...)`,
    );
    return seen;
  },
);

await step("slash menu lists commands; /scheduled sets a date", async () => {
  await page.keyboard.press("Escape");
  await enter(0);
  await page.keyboard.press("End");
  await page.keyboard.type(" /");
  await page.locator(".cmd-popup").first().waitFor({ timeout: 4000 });
  const all = await page
    .locator(".cmd-popup [role='option']")
    .evaluateAll((r) => r.map((x) => x.textContent.trim()));
  await page.keyboard.type("sched");
  await page.waitForTimeout(400);
  const rows = await page
    .locator(".cmd-popup [role='option']")
    .evaluateAll((r) => r.map((x) => x.textContent.trim()));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  // a date picker may be open; Enter picks the default (today)
  const picker = await page.locator(".date-picker, .calendar, [class*='date-pick']").count();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const b = (await blocks())[0];
  const sched = JSON.stringify((await api("page.read", { page: P, format: "json" })).tree[0]);
  assert(/scheduled/i.test(sched), `block after /scheduled: ${sched}`);
  return {
    slashCount: all.length,
    firstFew: all.slice(0, 8),
    schedRows: rows,
    picker,
    block: b.content,
  };
});

await step("typing a property line (key:: value) becomes a block property", async () => {
  await enter(2);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("status:: aktivní");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  const r = await api("page.read", { page: P, format: "json" });
  const node = r.tree[2];
  assert(node.properties?.status === "aktivní", `node ${JSON.stringify(node).slice(0, 300)}`);
  return node.properties;
});

await step("tasks view lists open tasks from the real graph", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/tasks`);
  await page.locator(".tasks-view").waitFor({ timeout: 10000 });
  await waitFor(async () => (await page.locator(".task-row").count()) > 0, 15000);
  const ms = Date.now() - t0;
  const n = await page.locator(".task-row").count();
  const groups = await page.locator(".task-group").count();
  const head = (await page.locator(".tasks-view").textContent()).slice(0, 300);
  return { ms, rows: n, groups, head };
});

await step("query fence renders results on the real graph (marker:LATER)", async () => {
  const Q = `Sweep Query ${stamp}`;
  await api("page.create", { name: Q, markdown: "- ```query\n  LATER\n  ```" });
  const t0 = Date.now();
  await page.goto(`${BASE}/page/${encodeURIComponent(Q)}`);
  const view = page.locator(".vr-query").first();
  await view.waitFor({ timeout: 10000 });
  await waitFor(async () => (await view.locator(".vr-query-count").count()) > 0, 15000);
  const count = await view.locator(".vr-query-count").textContent();
  return { count, ms: Date.now() - t0 };
});

await step(
  "Logseq {{query}} blocks from the graph (non-goal per PLAN) — what renders",
  async () => {
    await page.goto(`${BASE}/page/Inbox`);
    await page.waitForTimeout(2500);
    const t = (await page.locator(".vr-outliner").first().textContent()).slice(0, 200);
    return t;
  },
);

await step("/template inserts an owner template (Weekly planning)", async () => {
  const T = `Sweep Template ${stamp}`;
  await api("page.create", { name: T, markdown: "- " });
  await page.goto(`${BASE}/page/${encodeURIComponent(T)}`);
  await page.waitForFunction(() => !document.body.textContent.includes("Loading…"));
  await page.locator(".vr-outliner .vr-row").first().click();
  await page.keyboard.type("/template");
  const menu = page.locator(".cmd-popup").first();
  await menu.waitFor({ timeout: 4000 });
  await menu
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker = page.locator(".tpl-picker");
  await picker.waitFor({ timeout: 4000 });
  const opts = await picker
    .locator('[role="option"]')
    .evaluateAll((r) => r.map((x) => x.textContent.trim()));
  await page.keyboard.type("Weekly");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  const b = await readBlocks(T);
  assert(b.length > 1, `after template: ${JSON.stringify(b.map((x) => x.content))}`);
  return { templates: opts, inserted: b.length, first: b.slice(0, 3).map((x) => x.content) };
});

await step("command palette: Mod+K, page search 'Balení', open", async () => {
  await page.goto(`${BASE}/journals`);
  await page.waitForTimeout(1000);
  await page.keyboard.press(`${MOD}+k`);
  const pal = page.locator(".cmd-palette");
  await pal.waitFor({ timeout: 4000 });
  const t0 = Date.now();
  await pal.locator(".cmd-input").fill("Balení");
  await waitFor(async () => (await pal.locator(".cmd-row").count()) > 0, 5000, 20);
  const ms = Date.now() - t0;
  const rows = await pal
    .locator(".cmd-row")
    .evaluateAll((r) => r.slice(0, 5).map((x) => x.textContent.trim()));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  const url = decodeURIComponent(page.url());
  await page.keyboard.press(`${MOD}+k`);
  await pal.locator(".cmd-input").fill(">");
  await page.waitForTimeout(400);
  const cmds = await pal.locator(".cmd-row").count();
  await page.keyboard.press("Escape");
  assert(url.endsWith("/page/Balení"), url);
  return { ms, rows, url, commandCount: cmds };
});

await page.screenshot({ path: `${OUT}/tasks.png` });
console.log("ERRORS:", page.__errs.join("\n"));
console.log(JSON.stringify(results.map((r) => [r.ok ? "PASS" : "FAIL", r.name])));
await browser.close();
