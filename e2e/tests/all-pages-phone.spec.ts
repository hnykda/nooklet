/**
 * All pages at phone width (B-645): the columns collapse to name + blocks, the sort menu stands in
 * for the hidden headers, Delete is reachable without hover, and nothing is wider than the screen.
 * Its own file because `test.use` with a device cannot sit in a describe group.
 */

import { devices, expect, type Page, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

function run(): string {
  const info = test.info();
  return `${info.repeatEachIndex}${info.retry}`;
}

const names = (page: Page) => page.locator(".all-pages-name").allTextContents();

async function seedThree(page: Page, prefix: string): Promise<void> {
  await page.goto("/journals");
  // Blocks / words: Small 1 / 2, Mid 2 / 5, Big 3 / 9 (the plugin's rule: whitespace runs).
  await seedPage(page, `${prefix} Small`, "- two words");
  await seedPage(page, `${prefix} Mid`, "- one two three\n- four  five");
  await seedPage(page, `${prefix} Big`, "- a b c\n  - d e f\n- g\th  i");
}

async function openFiltered(page: Page, prefix: string): Promise<void> {
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill(prefix);
  await expect(page.locator(".all-pages-row")).toHaveCount(3);
}

test("at phone width the list keeps name + blocks, sorts from the menu, and fits the screen", async ({
  page,
}) => {
  const prefix = `Cols Phone ${run()}`;
  await seedThree(page, prefix);
  await openFiltered(page, prefix);

  await expect(page.locator('.all-pages-colhead[data-col="blocks"]')).toBeVisible();
  for (const col of ["words", "created", "updated"]) {
    await expect(page.locator(`.all-pages-colhead[data-col="${col}"]`)).toBeHidden();
    await expect(page.locator(`.all-pages-row [data-col="${col}"]`).first()).toBeHidden();
  }
  // Touch: the delete button is always shown, there is no hover to reveal it.
  await expect(page.getByRole("button", { name: `Delete ${prefix} Big` })).toBeVisible();

  await page.locator(".all-pages-sort").selectOption("words:desc");
  await expect
    .poll(() => names(page))
    .toEqual([`${prefix} Big`, `${prefix} Mid`, `${prefix} Small`]);

  const width = page.viewportSize()?.width ?? 0;
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(width);
  for (const box of await page
    .locator(".all-pages-row")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
    expect(box).toBeLessThanOrEqual(width);
  }
});
