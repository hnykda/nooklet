/**
 * The top bar's "⋯" menu (B-541 follow-up): Settings, All pages, Graph, Trash, Keyboard shortcuts
 * and Diagnostics, one click from anywhere. Each item is opened here for real — the menu runs
 * registered commands, so a command wired to nothing would show up as an item that does nothing.
 */
import { expect, type Page, test } from "@playwright/test";

async function choose(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: label }).click();
  await expect(menu).toHaveCount(0);
}

test("the ⋯ menu sits at the right end of the top bar and lists its six items", async ({
  page,
}) => {
  await page.goto("/journals");
  const more = page.getByRole("button", { name: "More" });
  await expect(more).toBeVisible();
  // Last control in the bar, flush with its right edge (less the bar's own padding).
  const bar = await page.locator(".app-topbar").boundingBox();
  const box = await more.boundingBox();
  expect(bar && box && bar.x + bar.width - (box.x + box.width)).toBeLessThan(20);

  await more.click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    /Settings/,
    /All pages/,
    /Graph/,
    /Trash/,
    /Keyboard shortcuts/,
    /Diagnostics/,
  ]);
  // Entirely on screen, anchored under the button.
  const m = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(m && viewport && m.x >= 0 && m.x + m.width <= viewport.width).toBe(true);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("each item opens what it says", async ({ page }) => {
  await page.goto("/journals");

  await choose(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);

  await choose(page, "All pages");
  await expect(page).toHaveURL(/\/pages$/);
  await expect(page.locator(".all-pages")).toBeVisible();

  await choose(page, "Graph");
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.locator(".graph-canvas-wrap")).toBeVisible();

  await choose(page, "Trash");
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.locator(".trash-view")).toBeVisible();

  await choose(page, "Keyboard shortcuts");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).toContainText("Open command palette");
  await page.keyboard.press("Escape");
  await expect(shortcuts).toHaveCount(0);

  await choose(page, "Diagnostics");
  await expect(page.locator(".diag-panel")).toBeVisible();
  await expect(page.locator(".diag-panel")).toContainText("This device");
});

test("a click outside closes the menu without doing anything", async ({ page }) => {
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menu", { name: "More" })).toBeVisible();
  await page.locator(".page-scroll").click({ position: { x: 20, y: 200 } });
  await expect(page.getByRole("menu", { name: "More" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/journals$/);
});

test("the palette reaches the same destinations by the same commands", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">open trash");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/trash$/);
});
