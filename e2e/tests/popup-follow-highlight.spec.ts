/**
 * B-746: arrowing through a popup list keeps the highlighted row visible. The highlight was an
 * index only, so past the last visible row it walked into the scrolled-out part of the list and
 * Enter picked something the person could not see.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { MOD, openEditing } from "../helpers/index.js";

/** The highlighted row lies inside the list's visible box. */
async function expectActiveVisible(list: Locator): Promise<void> {
  const inside = await list.evaluate((el) => {
    const row = el.querySelector('[aria-selected="true"]');
    if (!row) return "no highlighted row";
    const box = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
      ? "visible"
      : `row ${r.top}-${r.bottom} outside ${box.top}-${box.bottom}`;
  });
  expect(inside).toBe("visible");
}

async function scrolls(list: Locator): Promise<boolean> {
  return list.evaluate((el) => el.scrollHeight > el.clientHeight);
}

async function walk(page: Page, list: Locator, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("ArrowDown");
    await expectActiveVisible(list);
  }
}

test("B-746: the slash menu scrolls to keep the highlighted command in view", async ({ page }) => {
  await openEditing(page, "Popup Follow Slash", "- start");
  await page.keyboard.type(" /");
  const menu = page.locator(".cmd-popup");
  await expect(menu).toBeVisible();
  expect(await scrolls(menu), "the full slash list should overflow its popup").toBe(true);
  await walk(page, menu, 25);
  expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("B-746: the command palette scrolls to keep the highlighted row in view", async ({ page }) => {
  await openEditing(page, "Popup Follow Palette", "- start");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+k`);
  const list = page.locator("#cmd-palette-listbox");
  await expect(list).toBeVisible();
  expect(await scrolls(list), "the unfiltered palette should overflow").toBe(true);
  await walk(page, list, 25);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
