/**
 * The diagnostics panel: it exists because every backend failure so far has been invisible —
 * a missing token looked like a slow search, an unloaded sqlite-vec silently downgraded hybrid
 * search, and sync flapped with no way to see why.
 */
import { expect, test } from "@playwright/test";

test("opens from the sync indicator and reports backend state", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".app-sync-indicator").click();

  const panel = page.locator(".diag-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("This device");
  await expect(panel).toContainText("token present");

  // Backend section resolves with real numbers rather than sitting on "Checking…".
  await expect(panel).toContainText("Graph", { timeout: 10_000 });
  await expect(panel).toContainText("blocks");
  await expect(panel).toContainText("Full-text search");
  await expect(panel).toContainText("Vector search");
});

test("closes on backdrop click", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".app-sync-indicator").click();
  await expect(page.locator(".diag-panel")).toBeVisible();
  await page.locator(".diag-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".diag-panel")).toHaveCount(0);
});

test("closes on Escape, like every other overlay (B-594)", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".app-sync-indicator").click();
  await expect(page.locator(".diag-panel")).toBeVisible();
  // Once with focus inside the panel, once with nothing focused: both must close it.
  await page.locator(".diag-close").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".diag-panel")).toHaveCount(0);

  await page.locator(".app-sync-indicator").click();
  await expect(page.locator(".diag-panel")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(page.locator(".diag-panel")).toHaveCount(0);
});

test("says plainly when the API cannot be reached", async ({ page }) => {
  await page.goto("/journals");
  await page.route("**/api/v1/system.diagnostics", (route) => route.abort("failed"));
  await page.locator(".app-sync-indicator").click();
  await expect(page.locator(".diag-panel")).toContainText("Could not reach the API", {
    timeout: 10_000,
  });
});
