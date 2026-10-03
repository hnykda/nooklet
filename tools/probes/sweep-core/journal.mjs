// Sweep phase 1: today's journal — typing, Enter, Tab/Shift-Tab, move, multiline, collapse,
// undo/redo, typing latency, reload persistence. Usage: OUT=<dir> node .../journal.mjs
import {
  assert,
  BASE,
  editorText,
  isoToday,
  launch,
  MOD,
  newPage,
  OUT,
  readBlocks,
  results,
  rowDepths,
  rowTexts,
  step,
  waitFor,
} from "./lib.mjs";

const browser = await launch();
const { page } = await newPage(browser);
const today = isoToday();
const day = page.locator(".journal-day-today");

// Start from an empty today (deleting every block makes the journal virtual again).
for (const b of await readBlocks(today).catch(() => [])) {
  if (b.depth === 0) await (await import("./lib.mjs")).api("block.delete", { id: b.id });
}

await step("journals first load (cold context) until today is past 'Loading…'", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/journals`);
  await day.waitFor({ timeout: 30000 });
  const tDay = Date.now() - t0;
  await waitFor(async () => !(await day.textContent()).includes("Loading"), 30000, 50);
  return { todayHeadingMs: tDay, todayInteractiveMs: Date.now() - t0 };
});

await step("type into today's empty journal", async () => {
  const draft = day.locator(".vr-draft-input, .vr-empty-start, .vr-row").first();
  await draft.click();
  await page.keyboard.type("sweep one");
  await waitFor(async () => (await day.locator(".cm-content").count()) > 0);
  await page.waitForTimeout(400);
  const ed = await editorText(page);
  assert(ed === "sweep one", `editor text after typing = ${JSON.stringify(ed)}`);
  return ed;
});

await step("Enter, Tab, Enter, Shift-Tab builds the expected outline", async () => {
  await page.keyboard.press("Enter");
  await page.keyboard.type("sweep two");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("sweep three");
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(500);
  const outl = day.locator(".vr-outliner");
  const t = await rowTexts(outl);
  const d = await rowDepths(outl);
  assert(
    JSON.stringify(t) === JSON.stringify(["sweep one", "sweep two", "sweep three"]),
    `texts ${JSON.stringify(t)}`,
  );
  assert(JSON.stringify(d) === JSON.stringify([0, 1, 0]), `depths ${JSON.stringify(d)}`);
  return { t, d };
});

await step("Alt+Up moves block (with subtree semantics), Alt+Down moves back", async () => {
  const outl = day.locator(".vr-outliner");
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(300);
  const t1 = await rowTexts(outl);
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(300);
  const t2 = await rowTexts(outl);
  assert(t1[0] === "sweep three", `after Alt+Up ${JSON.stringify(t1)}`);
  assert(t2[2] === "sweep three", `after Alt+Down ${JSON.stringify(t2)}`);
  return { t1, t2 };
});

await step("Shift+Enter makes a multiline block", async () => {
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line ěščřžýáíé");
  await page.waitForTimeout(1500);
  const blocks = await readBlocks(today);
  const b = blocks.find((x) => x.content.startsWith("sweep three"));
  assert(
    b?.content === "sweep three\nsecond line ěščřžýáíé",
    `server content ${JSON.stringify(b)}`,
  );
  return b.content;
});

await step("collapse (Mod+Up) hides child, expand (Mod+Down) shows it", async () => {
  const outl = day.locator(".vr-outliner");
  // Go to "sweep one" — click its view.
  await outl.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await page.waitForTimeout(400);
  const n1 = (await rowTexts(outl)).length;
  await page.keyboard.press(`${MOD}+ArrowDown`);
  await page.waitForTimeout(400);
  const n2 = (await rowTexts(outl)).length;
  assert(n1 === 2 && n2 === 3, `rows collapsed=${n1} expanded=${n2}`);
  return { n1, n2 };
});

await step("undo / redo of typed text", async () => {
  await page.keyboard.press("End");
  await page.keyboard.type(" UNDOME");
  await page.waitForTimeout(800);
  const before = await editorText(page);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(500);
  const afterUndo = await editorText(page);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(500);
  const afterRedo = await editorText(page);
  assert(before === "sweep one UNDOME", `before ${before}`);
  assert(afterUndo === "sweep one", `afterUndo ${JSON.stringify(afterUndo)}`);
  assert(afterRedo === "sweep one UNDOME", `afterRedo ${JSON.stringify(afterRedo)}`);
  return { before, afterUndo, afterRedo };
});

await step("undo of a structural op (indent)", async () => {
  const outl = day.locator(".vr-outliner");
  // caret is in "sweep one UNDOME"; go to sweep three (row 2) and indent it, then undo
  await outl.locator(".vr-row").nth(2).locator(".vr-block-view").click();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
  const d1 = await rowDepths(outl);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(600);
  const d2 = await rowDepths(outl);
  assert(d1[2] === 1 && d2[2] === 0, `indent ${JSON.stringify(d1)} undo ${JSON.stringify(d2)}`);
  return { d1, d2 };
});

await step("typing latency: 120 chars at 0 delay, then per-key with 20ms delay", async () => {
  const outl = day.locator(".vr-outliner");
  await outl
    .locator(".vr-row")
    .nth(2)
    .locator(".vr-block-view")
    .click()
    .catch(() => {});
  await page.keyboard.press(`${MOD}+End`).catch(() => {});
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const s =
    "Příliš žluťoučký kůň úpěl ďábelské ódy. The quick brown fox jumps over the lazy dog 0123456789 "
      .repeat(1)
      .slice(0, 120);
  const t0 = Date.now();
  await page.keyboard.type(s);
  await waitFor(async () => (await editorText(page)) === s, 10000, 20);
  const burst = Date.now() - t0;
  // per-keystroke: time from keydown to the char being in the DOM
  const lat = await page.evaluate(async () => {
    const c = document.querySelector(".cm-content");
    const samples = [];
    for (let i = 0; i < 0; i++) samples.push(i);
    return { ok: !!c };
  });
  const per = [];
  for (const ch of "abcdefghij") {
    const before = (await editorText(page)).length;
    const t = Date.now();
    await page.keyboard.type(ch);
    await waitFor(async () => (await editorText(page)).length > before, 3000, 5);
    per.push(Date.now() - t);
  }
  await page.waitForTimeout(1500);
  const blocks = await readBlocks(today);
  const saved = blocks.some((b) => b.content === `${s}abcdefghij`);
  assert(
    saved,
    `server did not get the typed block: ${JSON.stringify(blocks.map((b) => b.content))}`,
  );
  return { burst120ms: burst, perKeyRoundTripMs: per, lat };
});

await step("reload persistence (today's blocks after reload)", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  await page.reload();
  await day.locator(".vr-row").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  const t = await rowTexts(day.locator(".vr-outliner"));
  const server = (await readBlocks(today)).map((b) => b.content);
  assert(t.length === server.length, `ui ${JSON.stringify(t)} server ${JSON.stringify(server)}`);
  return { ui: t, server };
});

await page.screenshot({ path: `${OUT}/journal.png` });
console.log("ERRORS:", page.__errs.join("\n"));
console.log(
  JSON.stringify(
    results.map((r) => [r.ok ? "PASS" : "FAIL", r.name]),
    null,
    0,
  ),
);
await browser.close();
