/**
 * The "⋯" menu on a phone (B-541 follow-up): Playwright's iPhone 13 descriptor, like `phone.spec.ts`.
 * The button must fit in the top bar at 390 px, the menu must stay on screen, and Keyboard shortcuts
 * is absent (B-564 — no keyboard to press them with).
 */
import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["iPhone 13"] });

test("at phone width the ⋯ menu fits on screen and leaves out keyboard shortcuts", async ({
  page,
}) => {
  await page.goto("/journals");
  const more = page.getByRole("button", { name: "More" });
  await expect(more).toBeVisible();
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const b = await more.boundingBox();
  expect(b && b.x + b.width <= viewport.width && b.y >= 0).toBe(true);
  // Still one row: the bar did not wrap or grow to make room.
  expect((await page.locator(".app-topbar").boundingBox())?.height).toBeLessThanOrEqual(45);

  await more.tap();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    /Settings/,
    /All pages/,
    /Graph/,
    /Trash/,
    /Diagnostics/,
  ]);
  const m = await menu.boundingBox();
  expect(m && m.x >= 0 && m.x + m.width <= viewport.width).toBe(true);
  // No key hints on a phone.
  await expect(menu.locator("kbd")).toHaveCount(0);

  await menu.getByRole("menuitem", { name: "Trash" }).tap();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(menu).toHaveCount(0);
});
