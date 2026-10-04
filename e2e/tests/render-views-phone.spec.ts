/**
 * The phone half of `render-views.spec.ts` (a device descriptor is per file): B-225, the page
 * title row's hover-revealed controls on a touch screen. Playwright's iPhone 13 descriptor — 390 px,
 * touch, `pointer: coarse`, no hover — as `phone.spec.ts` uses.
 */

import { devices, expect, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

test("a phone's title row has no invisible controls; History and Add icon are in the … menu (B-225)", async ({
  page,
}) => {
  const name = "RV Phone Title Row žluťoučký";
  await seedPage(page, name, "- a block");
  await page.goto(pagePath(name));
  const row = page.locator(".page-title-row");
  await expect(row.locator(".page-title-input")).toBeVisible();

  // Nothing hover-revealed is left in the row: invisible, those were still tap targets, and they
  // took the width the title needs (164 of 366 px before).
  await expect(row.locator(".page-history-link")).toBeHidden();
  await expect(row.locator(".page-icon-button-empty")).toBeHidden();
  const widths = await row.evaluate((el) => ({
    row: el.getBoundingClientRect().width,
    title: el.querySelector(".page-title-input")?.getBoundingClientRect().width ?? 0,
  }));
  expect(widths.title).toBeGreaterThan(widths.row * 0.6);

  // History, by touch.
  const actions = page.getByRole("button", { name: "Page actions" });
  await actions.tap();
  await page.getByRole("menuitem", { name: "Page history" }).tap();
  await expect(page.locator(".history-view h1")).toHaveText("History");
  await expect(page.locator(".history-back")).toContainText(name);

  // An icon, by touch.
  await page.goto(pagePath(name));
  await expect(row.locator(".page-title-input")).toBeVisible();
  await actions.tap();
  await page.getByRole("menuitem", { name: "Add icon" }).tap();
  const input = page.locator(".emoji-picker-search");
  await expect(input).toBeFocused();
  await input.fill("🌱");
  await input.press("Enter");
  const icon = row.locator(".page-icon-button");
  await expect(icon).toHaveText("🌱");
  await expect(icon).toBeVisible();

  // With an icon the menu stops offering one, and the icon itself is the way to change it.
  await actions.tap();
  await expect(page.getByRole("menuitem", { name: "Page history" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add icon" })).toHaveCount(0);
});
