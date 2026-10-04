/**
 * The corner `?`: the route to shortcuts and to filing a bug or feature request — the things
 * people want at the moment something confuses them.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const webPackage = JSON.parse(
  readFileSync(new URL("../../apps/web/package.json", import.meta.url), "utf8"),
) as { version: string };

test("the help menu opens and links to the issue templates", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();

  const menu = page.locator(".help-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator("a[href*='bug_report.yml']")).toBeVisible();
  await expect(menu.locator("a[href*='feature_request.yml']")).toBeVisible();
  // The build identifies itself, so a bug report can name it without anyone remembering. The
  // version is apps/web/package.json's (which `pnpm release` bumps), not a literal: this assertion
  // once pinned "0.1.0" to match a literal in vite.config.ts that disagreed with every package.
  await expect(menu).toContainText(`nooklet ${webPackage.version}`);
  await expect(menu.locator("a[href$='/nooklet/releases']")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("keyboard shortcuts are listed from the live keymap", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();
  await page.locator(".help-item", { hasText: "Keyboard shortcuts" }).click();

  const dialog = page.locator(".help-keys");
  await expect(dialog).toBeVisible();
  // Generated from the registry, so real commands with real bindings appear — a hand-written list
  // would be wrong the first time a binding changed.
  await expect(dialog).toContainText("Open command palette");
  await expect(dialog.locator("kbd")).not.toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
