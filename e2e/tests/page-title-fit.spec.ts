/**
 * The page title shows the whole name (B-350, B-225). On a 390px phone "Deciding on a Bike" read
 * "Deciding on a": the title shared its row with two controls that are invisible until hovered
 * (the empty icon slot and the History link — a touch screen never hovers) plus the star and "…",
 * and the title was an `<input>`, which cannot wrap, so any name longer than what was left was cut.
 *
 * Measured, not eyeballed: a field whose `scrollWidth`/`scrollHeight` exceeds its client box is
 * hiding part of its value.
 */

import { expect, type Page, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

async function titleBox(page: Page): Promise<{
  clippedX: boolean;
  clippedY: boolean;
  lines: number;
  right: number;
  viewport: number;
}> {
  const title = page.locator(".page-title-row .page-title-input");
  await expect(title).toBeVisible();
  return title.evaluate((el) => {
    const cs = getComputedStyle(el);
    const padding = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    return {
      clippedX: el.scrollWidth > el.clientWidth + 1,
      clippedY: el.scrollHeight > el.clientHeight + 1,
      lines: Math.round((el.clientHeight - padding) / Number.parseFloat(cs.lineHeight)),
      right: el.getBoundingClientRect().right,
      viewport: window.innerWidth,
    };
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a 17-character name fits on one line: the hover-only controls take no room (B-350, B-225)", async ({
    page,
  }) => {
    await openPage(page, "Choosing a Q1 Job");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const box = await titleBox(page);
    expect(box).toMatchObject({ clippedX: false, clippedY: false, lines: 1 });
    expect(box.right).toBeLessThanOrEqual(box.viewport);
    // Nothing to hover them into view with, so they are not in the row at all.
    await expect(page.locator(".page-history-link")).toBeHidden();
    await expect(page.locator(".page-icon-button-empty")).toBeHidden();
  });

  test("a long name wraps instead of being cut (B-350)", async ({ page }) => {
    await openPage(page, "Title Fit RPG on Harry Potter theme with Robin");
    const box = await titleBox(page);
    expect(box).toMatchObject({ clippedX: false, clippedY: false });
    expect(box.lines).toBeGreaterThanOrEqual(2);
  });

  test("the page's history and a new icon are in the … menu instead (B-225)", async ({ page }) => {
    await openPage(page, "Title Fit Menu/Child");
    await page.getByRole("button", { name: "Page actions" }).tap();
    await page.getByRole("menuitem", { name: "Add icon" }).tap();
    const icon = page.locator(".emoji-picker-search");
    await expect(icon).toBeFocused();
    await icon.fill("🎲");
    await icon.press("Enter");
    await expect(page.locator(".page-icon-button")).toHaveText("🎲");
    await expect(page.locator(".page-icon-button")).toBeVisible();

    await page.getByRole("button", { name: "Page actions" }).tap();
    await page.getByRole("menuitem", { name: "Page history" }).tap();
    await expect(page).toHaveURL(/\/history\/Title%20Fit%20Menu\/Child$/);
    await expect(page.locator(".history-view h1")).toHaveText("History");
  });
});

test("at desktop width a name longer than the row wraps rather than being cut (B-350)", async ({
  page,
}) => {
  await openPage(
    page,
    "Title Fit desktop: RPG on Harry Potter theme with Robin and the whole group",
  );
  const box = await titleBox(page);
  expect(box).toMatchObject({ clippedX: false, clippedY: false });
  expect(box.lines).toBeGreaterThanOrEqual(2);
});

test("Enter in the title renames without putting a line break into the name (B-350)", async ({
  page,
}) => {
  await openPage(page, "Title Fit Enter");
  const title = page.locator(".page-title-row .page-title-input");
  await title.fill("Title Fit Entered");
  await title.press("Enter");
  await expect(page).toHaveURL(/Title%20Fit%20Entered$/);
  await expect(title).toHaveValue("Title Fit Entered");
  await expect(title).not.toBeFocused();
});
