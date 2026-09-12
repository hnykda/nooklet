/**
 * Appearance basics (M7, research/13 §4.2 item 6): text size, content width and custom CSS. The
 * unit suite proves the attributes and the `<style>` tag; only a real browser proves the tokens
 * in `styles/shell.css` actually move the outliner's font size and the column's width, and that a
 * reload brings the choice back.
 */
import { expect, type Page, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

async function openSettings(page: Page): Promise<void> {
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".set-panel")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator(".set-close").click();
  await expect(page.locator(".set-panel")).toHaveCount(0);
}

async function outlinerFontSize(page: Page): Promise<number> {
  return page
    .locator(".vr-outliner")
    .first()
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}

async function columnMaxWidth(page: Page): Promise<string> {
  return page.locator(".page-scroll-inner").evaluate((el) => getComputedStyle(el).maxWidth);
}

test("text size and content width move the tokens and survive a reload", async ({ page }) => {
  await openPage(page, "Appearance Page", "- some text to read");
  const baseline = await outlinerFontSize(page);
  const baselineWidth = await columnMaxWidth(page);

  await openSettings(page);
  await page.getByRole("button", { name: "Larger", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  await page.getByRole("button", { name: "Wide", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-measure", "wide");
  await closeSettings(page);

  expect(await outlinerFontSize(page)).toBeGreaterThan(baseline);
  expect(await columnMaxWidth(page)).not.toBe(baselineWidth);

  // Per device, in localStorage: it is there before the settings panel is ever opened again.
  await page.reload();
  await expect(page.locator(".vr-outliner").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  expect(await outlinerFontSize(page)).toBeGreaterThan(baseline);

  // Back to the defaults clears the attributes rather than writing the default sizes.
  await openSettings(page);
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await page.getByRole("button", { name: "Normal", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /.+/);
  await expect(page.locator("html")).not.toHaveAttribute("data-measure", /.+/);
  await closeSettings(page);
  expect(await outlinerFontSize(page)).toBe(baseline);
});

test("custom CSS applies as you type, is replaced not appended, and clears", async ({ page }) => {
  await openPage(page, "Appearance CSS", "- styled text");
  const title = page.locator(".page-title-input").first();

  await openSettings(page);
  const box = page.locator("#set-custom-css");
  await box.fill(".page-title-input { color: rgb(1, 2, 3) !important; }");
  await expect(title).toHaveCSS("color", "rgb(1, 2, 3)");

  // A second rule replaces the first: only one <style>, and the old colour is gone.
  await box.fill(".page-title-input { color: rgb(4, 5, 6) !important; }");
  await expect(title).toHaveCSS("color", "rgb(4, 5, 6)");
  expect(await page.locator("style#nooklet-custom-css").count()).toBe(1);

  await page.reload();
  await expect(page.locator(".page-title-input").first()).toHaveCSS("color", "rgb(4, 5, 6)");

  await openSettings(page);
  await page.locator("#set-custom-css").fill("");
  await expect(page.locator("style#nooklet-custom-css")).toHaveCount(0);
  await expect(page.locator(".page-title-input").first()).not.toHaveCSS("color", "rgb(4, 5, 6)");
});
