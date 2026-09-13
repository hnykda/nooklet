/**
 * A phone reaches the command palette by touch (B-352). Nothing in the shell opened it except
 * Cmd/Ctrl+K, so on a phone without a keyboard every command that has no button of its own —
 * Open a random page, Collapse all / Expand all, Open this page on shelf — was out of reach.
 *
 * Everything here is done with taps; the only keyboard use is typing into the palette's input,
 * which is what the on-screen keyboard does. The entry is the first row of the sidebar drawer.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { openPage, seedPage } from "../helpers/index.js";

function drawerButton(page: Page): Locator {
  return page.locator(".app-sidebar").getByRole("button", { name: "Command palette" });
}

async function openPaletteByTouch(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Toggle sidebar" }).tap();
  await drawerButton(page).tap();
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  // The drawer gets out of the way, or it would cover what the command does.
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  return palette;
}

async function runByTouch(page: Page, title: string): Promise<void> {
  const palette = await openPaletteByTouch(page);
  await page.keyboard.type(title);
  await palette
    .locator(".cmd-row", { hasText: new RegExp(`^${title}`) })
    .first()
    .tap();
  await expect(palette).toHaveCount(0);
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the drawer's first row opens the palette and closes the drawer (B-352)", async ({
    page,
  }) => {
    await openPage(page, "Phone Palette Opens");
    await openPaletteByTouch(page);
    await expect(page.locator(".cmd-input")).toBeFocused();
    await page.locator(".cmd-overlay").tap({ position: { x: 5, y: 830 } });
    await expect(page.locator(".cmd-palette")).toHaveCount(0);
  });

  test("Collapse all and Expand all run by touch (B-352)", async ({ page }) => {
    const outliner = await openPage(
      page,
      "Phone Palette Collapse",
      "- a\n  - a1\n- b\n  - b1\n- c",
    );
    await expect(outliner.locator(".vr-row")).toHaveCount(5);
    await runByTouch(page, "Collapse all");
    await expect(outliner.locator(".vr-row")).toHaveCount(3);
    await runByTouch(page, "Expand all");
    await expect(outliner.locator(".vr-row")).toHaveCount(5);
  });

  test("Open a random page runs by touch (B-352)", async ({ page }) => {
    await seedPage(page, "Phone Palette Random Other", "- somewhere else");
    await openPage(page, "Phone Palette Random", "- here");
    const before = page.url();
    await runByTouch(page, "Open a random page");
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page).toHaveURL(/\/page\//);
  });

  test("Open this page on shelf runs by touch (B-352)", async ({ page }) => {
    await openPage(page, "Phone Palette Shelf", "- keep me");
    await runByTouch(page, "Open this page on shelf");
    await expect(page.locator(".app-shelf .shelf-card").first()).toHaveAttribute(
      "data-shelf-key",
      "page:phone palette shelf",
    );
  });
});

test("on a desktop the sidebar's Command palette row shows the shortcut and leaves the sidebar open (B-352)", async ({
  page,
}) => {
  await openPage(page, "Desktop Palette Row");
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const row = page.locator(".app-sidebar").getByRole("button", { name: /Command palette/ });
  await expect(row.locator("kbd")).toHaveText(/^(Cmd|Ctrl)\+K$/);
  await row.click();
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
});
