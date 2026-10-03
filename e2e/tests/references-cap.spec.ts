/**
 * The references panel on a much-referenced page (QA finding Q3, docs/bugs-inbox/qafix-views.md
 * B-253). It used to fetch the first 200 linked and 50 unlinked references and present that slice
 * as the whole: on the real graph "CAMP" said 200 linked (836 real) and 50 unlinked, while Link
 * all rewrote 187; a filter could say "No references match" while matches sat past row 200.
 *
 * Seeded shape: 5 older blocks that also mention a rare page (so they sort last, past row 200),
 * 200 newer linked blocks, and 60 plain mentions.
 */
import { expect, type Page, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

const TARGET = "Refcap Target";

function bullets(n: number, line: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => `- ${line(i + 1)}`).join("\n");
}

async function seedGraph(page: Page): Promise<void> {
  await seedPage(page, TARGET, "- the target");
  await seedPage(
    page,
    "Refcap Old",
    bullets(5, (i) => `[[${TARGET}]] old ${i} with [[Refcap Rare]]`),
  );
  // A separate, later write: these 200 are newer, so "most recent first" puts the 5 above last.
  await page.waitForTimeout(20);
  await seedPage(
    page,
    "Refcap Many",
    bullets(200, (i) => `[[${TARGET}]] many ${i}`),
  );
  await seedPage(
    page,
    "Refcap Plain",
    bullets(60, (i) => `plain ${TARGET} mention ${i}`),
  );
}

function linked(page: Page) {
  return page.locator(".linked-references");
}

test("counts, filters and Link all cover every reference, not the first 200 / 50", async ({
  page,
}) => {
  await seedGraph(page);
  await page.goto(pagePath(TARGET));

  const section = linked(page);
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("205");

  // The filter is computed over all 205: the rare page is only on the 5 oldest.
  await section.getByRole("button", { name: "Filter linked references" }).click();
  const popover = page.getByRole("dialog", { name: "Filter linked references" });
  const rare = popover.locator(".references-filter-option", { hasText: "Refcap Rare" });
  await expect(rare.locator(".reference-count")).toHaveText("5");
  await rare.click();
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("5 of 205");
  await expect(section.locator(".reference-item")).toHaveCount(5);
  await rare.click(); // exclude
  await rare.click(); // clear
  await page.keyboard.press("Escape");
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("205");

  // Not all 205 are rendered at once, and the panel says there are more rather than stopping.
  await expect(section.locator(".reference-item")).toHaveCount(200);
  await section.locator(".references-more").click();
  await expect(section.locator(".reference-item")).toHaveCount(205);
  await expect(section.locator(".references-more")).toHaveCount(0);

  // Unlinked: all 60, and Link all changes exactly that many.
  const unlinked = page.locator(".unlinked-references");
  await expect(unlinked.locator(".references-toggle .reference-count")).toHaveText("60");
  await unlinked.locator(".references-link-all").click();
  await expect(page.locator(".references-status")).toContainText("Linked 60 mention(s)");
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("265");
});
