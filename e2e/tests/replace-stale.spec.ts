/**
 * Find & Replace must write what the fields show (QA finding Q1, docs/bugs-inbox/qafix-views.md
 * B-250). The preview is debounced by 250 ms; Replace all used to send the debounced input, so a
 * click inside that window wrote the replacement from before the last keystrokes — on the real
 * graph an empty string, deleting all 19 matches while the outcome line looked like success.
 */

import { expect, type Page, test } from "@playwright/test";
import { readBlocks, seedPage } from "../helpers/index.js";

async function contents(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("Replace all clicked straight after typing the replacement writes that replacement", async ({
  page,
}) => {
  await seedPage(page, "Replace Stale One", "- líbí se jí quokkaville, líbilo by");
  await seedPage(page, "Replace Stale Two", "- Quokkaville again");
  await page.goto("/replace");

  await page.locator(".replace-query").fill("quokkaville");
  await expect(page.locator(".replace-summary")).toHaveText("2 occurrences in 2 blocks");
  await expect(page.locator(".replace-all")).toBeEnabled();

  // Within the debounce: the preview on screen is still the one for an empty replacement.
  await page.locator(".replace-replacement").fill("Quokkaville (Praha 6)");
  await page.locator(".replace-all").click();

  await expect(page.locator(".replace-outcome")).toHaveText("Replaced 2 occurrences in 2 blocks.");
  expect(await contents(page, "Replace Stale One")).toEqual([
    "líbí se jí Quokkaville (Praha 6), líbilo by",
  ]);
  expect(await contents(page, "Replace Stale Two")).toEqual(["Quokkaville (Praha 6) again"]);
});

test("Replace all is disabled while the preview is for different fields than the ones shown", async ({
  page,
}) => {
  await seedPage(page, "Replace Stale Gate", "- a wombatish line\n- wombatish too");
  await page.goto("/replace");

  await page.locator(".replace-query").fill("wombatish");
  await expect(page.locator(".replace-summary")).toHaveText("2 occurrences in 2 blocks");
  await expect(page.locator(".replace-all")).toBeEnabled();

  // Typed keystroke by keystroke, then Tab away, as a person does: the button must not be
  // clickable until the preview has caught up with the last keystroke.
  await page.locator(".replace-replacement").focus();
  await page.keyboard.type("QAREPL");
  await expect(page.locator(".replace-all")).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(page.locator(".replace-after").first()).toContainText("QAREPL");
  await expect(page.locator(".replace-all")).toBeEnabled();

  // A new query disables it again until its own preview has arrived.
  await page.locator(".replace-query").fill("wombatish too");
  await expect(page.locator(".replace-all")).toBeDisabled();
  await expect(page.locator(".replace-summary")).toHaveText("1 occurrence in 1 block");
  await page.locator(".replace-all").click();
  await expect(page.locator(".replace-outcome")).toHaveText("Replaced 1 occurrence in 1 block.");
  expect(await contents(page, "Replace Stale Gate")).toEqual(["a wombatish line", "QAREPL"]);
});
