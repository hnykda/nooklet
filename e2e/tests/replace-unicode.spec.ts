/**
 * B-128: `/replace` regexes run in Unicode mode on the server AND in the view's highlight, so a
 * Czech graph can use `\p{…}` classes. Without the `u` flag `\p{Lu}` is the literal text "p{Lu}":
 * the preview said "No matches." with no hint why.
 */
import { expect, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test("a \\p{…} class previews the Czech words it matches, highlighted", async ({ page }) => {
  await seedPage(page, "Replace Unicode", "- Schůzka s Alešem: Černá kniha");
  await page.goto("/replace");
  await page.locator(".replace-regex").check();
  await page.locator(".replace-case").check();
  await page.locator(".replace-query").fill("Č\\p{Ll}+á");
  await expect(page.locator(".replace-summary")).toHaveText("1 occurrence in 1 block");
  await expect(page.locator(".replace-before mark")).toHaveText(["Černá"]);
});
