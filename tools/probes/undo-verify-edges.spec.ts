/**
 * Probe (2026-09-13, verifying m9/undo): edge cases around the B-142/B-162/B-194 undo fixes, run
 * against the e2e server. Each test logs what it saw rather than asserting the answer, because
 * several of these were questions, not claims. Results at `695af3a`, before the B-281 fix (e2e port 6400):
 *
 * - P1 editing one journal day, chip date in another, Cmd/Ctrl+Z: date undone, typing kept (at
 *   `cf08d19`: typing undone, date kept).
 * - P2 Cmd/Ctrl+Enter twice with no pause: marker `TODO`, not `DOING` — same at `cf08d19` (B-282).
 * - P3 repeat-aware DOING→DONE via Cmd/Ctrl+Enter, undo and redo: marker, scheduled and done all
 *   restored on the server.
 * - P4 selection mode Cmd/Ctrl+Enter, undo, redo: selection kept, redo writes TODO again.
 * - P5 unflushed `kind:: ab` edit then Cmd/Ctrl+Enter: two undos, `kind:: ab` then `kind:: a`.
 * - P6 remote `block.delete` of the last-edited block: the undo takes back the older step instead.
 * - P7 Czech + emoji text, `/scheduled`, undo: text intact, next undo takes the text back.
 * - P8 block left selected in one day, chip date in another: typing undone, date kept — B-281,
 *   fixed in `9546dff` (the e2e test for it is in `e2e/tests/undo-gaps.spec.ts`).
 * - P9 palette "Set deadline date" in selection mode, undo: date cleared, selection kept.
 * - P13 undo of an expand that folds the edited row: editing ends (as before the branch).
 * - P14 a block selection stays when another day is clicked into, and after a click on the body.
 *
 * To re-run: copy into `e2e/tests/`, `export NOOKLET_DATA=<scratch>/data`, then
 * `cd e2e && NOOKLET_E2E_PORT=<port> pnpm exec playwright test tests/undo-verify-edges.spec.ts
 * --project=chromium --reporter=list`, and delete the copy. Journal days -4 and -6 are shared with
 * `undo-gaps.spec.ts`; run this alone, not inside the suite.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  activeElement,
  api,
  clickRow,
  editingRowIndex,
  editor,
  editorText,
  isoOffset,
  MOD,
  openEditing,
  openPage,
  readBlocks,
} from "../helpers/index.js";

interface Node {
  id: string;
  content: string;
  marker?: string | null;
  priority?: string | null;
  collapsed?: boolean;
  properties?: Record<string, string>;
  children?: Node[];
}
async function serverBlocks(page: Page, name: string): Promise<Node[]> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Node[] = [];
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

test("P1 cross-tree: editing one journal day, date chip in another, Cmd+Z", async ({ page }) => {
  const dayA = isoOffset(-4);
  const dayB = isoOffset(-6);
  await api(page, "page.append", { page: dayA, markdown: "- cross tree edited" });
  await api(page, "page.append", {
    page: dayB,
    markdown: `- cross tree chip\n  deadline:: ${isoOffset(-40)}`,
  });
  await page.goto("/journals");
  const secA = page.locator(".journal-day", { hasText: "cross tree edited" });
  const secB = page.locator(".journal-day", { hasText: "cross tree chip" });
  await expect(secA).toHaveCount(1);
  await expect(secB).toHaveCount(1);
  await secA.locator(".vr-block-view", { hasText: "cross tree edited" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await expect
    .poll(async () => (await serverBlocks(page, dayA))[0]?.content)
    .toBe("cross tree edited typed");
  await secB.locator('.vr-date[data-field="deadline"]').click();
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+12d");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect
    .poll(async () => (await serverBlocks(page, dayB))[0]?.properties?.deadline)
    .toBe(isoOffset(12));
  console.log("P1 active after pick:", await activeElement(page));
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1500);
  console.log("P1 after Cmd+Z: dayA =", (await serverBlocks(page, dayA))[0]?.content);
  console.log(
    "P1 after Cmd+Z: dayB deadline =",
    (await serverBlocks(page, dayB))[0]?.properties?.deadline,
  );
  console.log("P1 active after undo:", await activeElement(page));
});

test("P2 rapid double Cmd+Enter", async ({ page }) => {
  const name = "Undo Verify Rapid Cycle";
  await openEditing(page, name, "- rapid");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(1500);
  console.log("P2 marker after two presses:", (await serverBlocks(page, name))[0]?.marker);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1000);
  console.log("P2 marker after one undo:", (await serverBlocks(page, name))[0]?.marker);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1000);
  console.log(
    "P2 marker after two undos:",
    (await serverBlocks(page, name))[0]?.marker,
    (await serverBlocks(page, name))[0]?.content,
  );
});

test("P3 repeat completion undo", async ({ page }) => {
  const name = "Undo Verify Repeat";
  const outliner = await openEditing(
    page,
    name,
    `- DOING water fern\n  scheduled:: ${isoOffset(-50)}\n  repeat:: 1w`,
  );
  const before = (await serverBlocks(page, name))[0];
  console.log("P3 before:", JSON.stringify(before));
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(async () => (await serverBlocks(page, name))[0]?.properties?.done).toBeTruthy();
  console.log("P3 after complete:", JSON.stringify((await serverBlocks(page, name))[0]));
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1500);
  const after = (await serverBlocks(page, name))[0];
  console.log("P3 after undo:", JSON.stringify(after));
  console.log(
    "P3 row text:",
    await outliner.locator(".vr-row").first().textContent(),
    await editorText(page),
  );
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(1500);
  console.log("P3 after redo:", JSON.stringify((await serverBlocks(page, name))[0]));
});

test("P4 selection mode Cmd+Enter, undo, redo", async ({ page }) => {
  const name = "Undo Verify Selection";
  const outliner = await openEditing(page, name, "- sel one\n- sel two");
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(async () => (await serverBlocks(page, name))[0]?.marker).toBe("TODO");
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await serverBlocks(page, name))[0]?.marker ?? null).toBeNull();
  console.log(
    "P4 selected after undo:",
    await outliner.locator(".vr-row-selected").count(),
    await activeElement(page),
  );
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(1000);
  console.log("P4 marker after redo:", (await serverBlocks(page, name))[0]?.marker);
});

test("P5 unflushed property line then Cmd+Enter, undo twice", async ({ page }) => {
  const name = "Undo Verify Prop Line";
  const outliner = await openEditing(page, name, "- item\n  kind:: a");
  await expect.poll(() => editorText(page)).toBe("item\nkind:: a");
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("b");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(async () => (await serverBlocks(page, name))[0]?.marker).toBe("TODO");
  console.log(
    "P5 after cycle:",
    JSON.stringify((await serverBlocks(page, name))[0]),
    JSON.stringify(await editorText(page)),
  );
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1200);
  console.log(
    "P5 after undo1:",
    JSON.stringify((await serverBlocks(page, name))[0]),
    JSON.stringify(await editorText(page)),
  );
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1200);
  console.log(
    "P5 after undo2:",
    JSON.stringify((await serverBlocks(page, name))[0]),
    JSON.stringify(await editorText(page)),
  );
  await page.keyboard.type("Ž");
  await page.waitForTimeout(1200);
  console.log(
    "P5 after typing:",
    JSON.stringify((await serverBlocks(page, name))[0]),
    JSON.stringify(await editorText(page)),
    await editingRowIndex(page, outliner),
  );
});

test("P6 remote delete of the last-edited block: undo reaches the older step", async ({ page }) => {
  const name = "Undo Verify Remote Delete";
  const outliner = await openEditing(page, name, "- keep\n- gone");
  await page.keyboard.type(" k1");
  await page.waitForTimeout(700);
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.type(" g1");
  await page.waitForTimeout(700);
  const gone = (await readBlocks(page, name)).find((b) => b.content.startsWith("gone"));
  await clickRow(page, outliner, 0);
  await api(page, "block.delete", { id: gone?.id });
  await expect.poll(() => outliner.locator(".vr-row").count(), { timeout: 15000 }).toBe(1);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1200);
  console.log(
    "P6 after undo:",
    JSON.stringify((await readBlocks(page, name)).map((b) => b.content)),
    await activeElement(page),
    await editingRowIndex(page, outliner),
  );
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(1200);
  console.log(
    "P6 after redo:",
    JSON.stringify((await readBlocks(page, name)).map((b) => b.content)),
    await activeElement(page),
  );
});

test("P7 Czech text then slash date, undo keeps text", async ({ page }) => {
  const name = "Undo Verify Czech";
  await openEditing(page, name, "- úkol");
  await page.keyboard.type(" Příliš žluťoučký kůň úpěl ďábelské ódy 🐎");
  await page.keyboard.type(" /sched");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu.locator(".cmd-row--active")).toHaveText("Scheduled");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+30d");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await serverBlocks(page, name))[0]?.properties?.scheduled)
    .toBe(isoOffset(30));
  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(async () => (await serverBlocks(page, name))[0]?.properties?.scheduled)
    .toBeUndefined();
  console.log(
    "P7:",
    JSON.stringify((await serverBlocks(page, name))[0]?.content),
    JSON.stringify(await editorText(page)),
  );
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1000);
  console.log(
    "P7 undo2:",
    JSON.stringify((await serverBlocks(page, name))[0]?.content),
    JSON.stringify(await editorText(page)),
  );
});

test("P8 selection in one journal day, chip date in another, Cmd+Z", async ({ page }) => {
  const dayA = isoOffset(-4);
  const dayB = isoOffset(-6);
  await api(page, "page.append", { page: dayA, markdown: "- sel tree edited" });
  await api(page, "page.append", {
    page: dayB,
    markdown: `- sel tree chip\n  deadline:: ${isoOffset(-41)}`,
  });
  await page.goto("/journals");
  const secA = page.locator(".journal-day", { hasText: "sel tree edited" });
  const secB = page.locator(".journal-day", { hasText: "sel tree chip" });
  await secA.locator(".vr-block-view", { hasText: "sel tree edited" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed2");
  await page.keyboard.press("Escape");
  await expect(secA.locator(".vr-row-selected")).toHaveCount(1);
  await expect
    .poll(async () => (await serverBlocks(page, dayA)).map((b) => b.content))
    .toContain("sel tree edited typed2");
  const chip = secB
    .locator(".vr-row", { hasText: "sel tree chip" })
    .locator('.vr-date[data-field="deadline"]');
  await chip.click();
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+13d");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  const chipBlock = async () =>
    (await serverBlocks(page, dayB)).find((b) => b.content === "sel tree chip");
  await expect.poll(async () => (await chipBlock())?.properties?.deadline).toBe(isoOffset(13));
  console.log(
    "P8 selectedA after pick:",
    await secA.locator(".vr-row-selected").count(),
    await activeElement(page),
  );
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1500);
  console.log(
    "P8 after Cmd+Z: dayA =",
    JSON.stringify((await serverBlocks(page, dayA)).map((b) => b.content)),
  );
  console.log(
    "P8 after Cmd+Z: dayB deadline =",
    (await chipBlock())?.properties?.deadline,
    "expected",
    isoOffset(-41),
  );
});

test("P9 selection mode palette Set deadline, undo keeps selection", async ({ page }) => {
  const name = "Undo Verify Sel Deadline";
  const outliner = await openEditing(page, name, "- sd one\n- sd two");
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await palette.locator(".cmd-input").fill("Set deadline date");
  await expect(palette.locator(".cmd-row--active")).toHaveText(/^Set deadline date/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+44d");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await serverBlocks(page, name))[0]?.properties?.deadline)
    .toBe(isoOffset(44));
  console.log(
    "P9 after pick active:",
    await activeElement(page),
    await outliner.locator(".vr-row-selected").count(),
  );
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1500);
  console.log(
    "P9 after undo:",
    (await serverBlocks(page, name))[0]?.properties?.deadline,
    await outliner.locator(".vr-row-selected").count(),
    await activeElement(page),
  );
});

test("P13 undo an expand that folds the edited row", async ({ page }) => {
  const name = "Undo Verify Expand Fold";
  const outliner = await openPage(page, name, "- efparent\n  collapsed:: true\n  - efkid");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await clickRow(page, outliner, 0);
  await page.keyboard.press(`${MOD}+ArrowDown`);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(800);
  console.log(
    "P13 rows:",
    await outliner.locator(".vr-row").count(),
    "editing:",
    await editingRowIndex(page, outliner),
    await activeElement(page),
  );
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(800);
  console.log(
    "P13 after redo rows:",
    await outliner.locator(".vr-row").count(),
    await activeElement(page),
  );
});

test("P14 selection in one day, click a row in another day: does the selection stay?", async ({
  page,
}) => {
  const dayA = isoOffset(-4);
  const dayB = isoOffset(-6);
  await api(page, "page.append", { page: dayA, markdown: "- p14 sel" });
  await api(page, "page.append", { page: dayB, markdown: "- p14 other" });
  await page.goto("/journals");
  const secA = page.locator(".journal-day", { hasText: "p14 sel" });
  const secB = page.locator(".journal-day", { hasText: "p14 other" });
  await secA.locator(".vr-block-view", { hasText: "p14 sel" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(secA.locator(".vr-row-selected")).toHaveCount(1);
  await secB.locator(".vr-block-view", { hasText: "p14 other" }).click();
  await expect(editor(page)).toBeFocused();
  console.log(
    "P14 selection in A after click into B:",
    await secA.locator(".vr-row-selected").count(),
  );
  await page.keyboard.press("Escape");
  console.log(
    "P14 selection in A after Escape in B:",
    await secA.locator(".vr-row-selected").count(),
    await secB.locator(".vr-row-selected").count(),
  );
  // Now click on empty chrome
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  console.log(
    "P14 selections after body click:",
    await secA.locator(".vr-row-selected").count(),
    await secB.locator(".vr-row-selected").count(),
  );
});
