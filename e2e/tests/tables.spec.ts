/**
 * GFM tables in a real browser (B-702).
 *
 * The unit tests check the classifier and the renderer in jsdom; this checks what a person sees on
 * a production build, and that editing a table block and leaving it writes back exactly the text
 * that was typed. The old renderer test checked only the table's structure, so every cell of a
 * `| a | b |` table rendering as `|` passed it; these read the cells' text.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { clickRow, editor, MOD, openPage, readBlocks, runName } from "../helpers/index.js";

async function cellTexts(table: Locator): Promise<string[][]> {
  return table
    .locator("tr")
    .evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent ?? "")),
    );
}

function tableOf(page: Page, row: number): Locator {
  return page.locator(".vr-outliner").first().locator(".vr-row").nth(row).locator(".vr-table");
}

test("B-702: leading-pipe tables render their cells' text, alignment and escaped pipes", async ({
  page,
}, info) => {
  const name = runName("Tables Render", info);
  await openPage(
    page,
    name,
    [
      "- | Fruit | Count | Note |",
      "  | :--- | ---: | :---: |",
      "  | Pear \\| Quince | 3 | **ripe** |",
      "  | Fig | 12 |",
      "- Chores for the week:",
      "",
      "  | Day | Task |",
      "  |---|---|",
      "  | Mon | [[Laundry]] |",
      "",
      "  Rest to follow.",
      "- a | b",
      "  ---|---",
      "  1 | 2",
    ].join("\n"),
  );

  const first = tableOf(page, 0);
  await expect(first).toBeVisible();
  expect(await cellTexts(first)).toEqual([
    ["Fruit", "Count", "Note"],
    ["Pear | Quince", "3", "ripe"],
    ["Fig", "12", ""],
  ]);
  const aligns = await first
    .locator("tr")
    .first()
    .locator("th")
    .evaluateAll((ths) => ths.map((th) => getComputedStyle(th).textAlign));
  expect(aligns).toEqual(["left", "right", "center"]);
  await expect(first.locator("td strong")).toHaveText("ripe");

  // Prose, a blank line, then the table: the shape every table in a real Logseq graph has.
  const mixedRow = page.locator(".vr-outliner").first().locator(".vr-row").nth(1);
  await expect(mixedRow.locator("p.vr-paragraph").first()).toHaveText("Chores for the week:");
  expect(await cellTexts(tableOf(page, 1))).toEqual([
    ["Day", "Task"],
    ["Mon", "Laundry"],
  ]);
  await expect(tableOf(page, 1).locator("a.vr-page-ref")).toHaveText("Laundry");
  await expect(mixedRow.locator("p.vr-paragraph").last()).toHaveText("Rest to follow.");

  expect(await cellTexts(tableOf(page, 2))).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("B-702: editing a table block writes back exactly what was typed", async ({ page }, info) => {
  const name = runName("Tables Edit", info);
  const original = "| a | b |\n| :-- | --: |\n| 1 \\| 1 | 2 |";
  const outliner = await openPage(page, name, `- ${original.replaceAll("\n", "\n  ")}`);
  await expect(tableOf(page, 0)).toBeVisible();

  // Enter and leave without typing: nothing changes.
  await clickRow(page, outliner, 0);
  await expect(editor(page)).toContainText("| :-- | --: |");
  await page.keyboard.press("Escape");
  await expect(tableOf(page, 0)).toBeVisible();
  expect((await readBlocks(page, name))[0]?.content).toBe(original);

  // Type into the last cell.
  await clickRow(page, outliner, 0);
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("9");
  await page.keyboard.press("Escape");
  const edited = "| a | b |\n| :-- | --: |\n| 1 \\| 1 | 29 |";
  await expect.poll(async () => (await readBlocks(page, name))[0]?.content).toBe(edited);
  expect(await cellTexts(tableOf(page, 0))).toEqual([
    ["a", "b"],
    ["1 | 1", "29"],
  ]);
});
