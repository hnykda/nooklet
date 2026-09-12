/**
 * Find & Replace at `/replace` (research/13 §4.2 item 4): the preview is `graph.replace`'s
 * `dry_run`, Replace all is the same call for real (one batch), Undo is `batch.undo` on that
 * batch. Assertions are on the screen and on what the API says the blocks now contain.
 */

import { expect, type Page, test } from "@playwright/test";
import { pagePath, readBlocks, rowTexts, seedPage } from "../helpers/index.js";

async function contents(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("previews matches live, replaces all in one batch, and Undo restores every block", async ({
  page,
}) => {
  await seedPage(page, "Replace One", "- the colour of money\n  - Colour me surprised");
  await seedPage(page, "Replace Two", "- no colour here either");
  await page.goto("/replace");

  await expect(page.locator(".replace-hint")).toContainText("Type to preview");
  await expect(page.locator(".replace-all")).toBeDisabled();

  await page.locator(".replace-query").fill("colour");
  await expect(page.locator(".replace-summary")).toHaveText("3 occurrences in 3 blocks");
  await expect(page.locator(".replace-result")).toHaveCount(3);
  await expect(page.locator(".replace-before mark").first()).toHaveText(/colour/i);
  await expect(page.locator(".replace-all")).toBeEnabled();

  await page.locator(".replace-replacement").fill("color");
  await expect(page.locator(".replace-after").first()).toContainText("color");
  await page.locator(".replace-all").click();

  await expect(page.locator(".replace-outcome")).toHaveText("Replaced 3 occurrences in 3 blocks.");
  await expect(page.locator(".replace-summary")).toHaveText("No matches.");
  expect(await contents(page, "Replace One")).toEqual(["the color of money", "color me surprised"]);
  expect(await contents(page, "Replace Two")).toEqual(["no color here either"]);

  await page.locator(".replace-undo").click();
  await expect(page.locator(".replace-outcome")).toHaveText("Undone: 3 blocks restored.");
  await expect(page.locator(".replace-undo")).toHaveCount(0);
  await expect(page.locator(".replace-summary")).toHaveText("3 occurrences in 3 blocks");
  expect(await contents(page, "Replace One")).toEqual([
    "the colour of money",
    "Colour me surprised",
  ]);
});

test("the replaced page shows the new text in the outliner without a reload of the app", async ({
  page,
}) => {
  await seedPage(page, "Replace Live", "- a favourite word");
  await page.goto("/replace");
  await page.locator(".replace-query").fill("favourite");
  await page.locator(".replace-replacement").fill("favorite");
  await expect(page.locator(".replace-summary")).toContainText("1 occurrence in 1 block");
  await page.locator(".replace-all").click();
  await expect(page.locator(".replace-outcome")).toContainText("Replaced 1 occurrence");
  // Client-side navigation: the local replica must already hold the pulled change.
  await page.goto(pagePath("Replace Live"));
  await expect.poll(() => rowTexts(page)).toEqual(["a favorite word"]);
});

test("Match case and Regular expression change what matches; a bad pattern says so", async ({
  page,
}) => {
  // A word of its own: the specs in this file share one server, and the earlier ones leave
  // "colour" behind (restored by Undo), so counting that word here would count theirs too.
  await seedPage(page, "Replace Modes", "- Sulphur and sulphur\n- sulphur: none");
  await page.goto("/replace");
  await page.locator(".replace-query").fill("Sulphur");
  await expect(page.locator(".replace-summary")).toHaveText("3 occurrences in 2 blocks");

  await page.locator(".replace-case").check();
  await expect(page.locator(".replace-summary")).toHaveText("1 occurrence in 1 block");
  await page.locator(".replace-case").uncheck();

  await page.locator(".replace-regex").check();
  await page.locator(".replace-query").fill("sulph(u|o)r:");
  await expect(page.locator(".replace-summary")).toHaveText("1 occurrence in 1 block");
  await expect(page.locator(".replace-result-page")).toContainText("Replace Modes");

  await page.locator(".replace-query").fill("(");
  await expect(page.locator(".replace-error")).toContainText("not a valid regular expression");
  await expect(page.locator(".replace-all")).toBeDisabled();
});
