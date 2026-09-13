/**
 * Clearing the search box clears the results (B-353). With an empty query no search runs, and the
 * resource behind the list kept its last value — so "Type to search." showed on top of the old
 * summary and every old row, and a filter chosen next sat over rows it did not describe (on the
 * owner's graph: 49 "zaplatit" hits, DONE and unmarked among them, under Task = LATER).
 */

import { expect, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test("an emptied query shows only the hint, and a filter chosen then shows no stale rows (B-353)", async ({
  page,
}) => {
  await seedPage(
    page,
    "Cleared Search Quokka",
    "- DONE quokkaclear paid\n- quokkaclear unmarked\n- LATER quokkaclear someday",
  );
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  const input = page.locator(".search-query-input");
  await input.fill("quokkaclear");
  await expect(page.locator(".search-summary")).toHaveText("3 results", { timeout: 15_000 });

  await input.fill("");
  await expect(page.locator(".search-hint")).toHaveText("Type to search.");
  await expect(page.locator(".search-summary")).toHaveCount(0);
  await expect(page.locator(".search-result")).toHaveCount(0);

  await page.locator(".search-filters summary").click();
  await page.locator(".search-filter-marker").selectOption("LATER");
  await expect(page.locator(".search-result")).toHaveCount(0);
  await expect(page.locator(".search-summary")).toHaveCount(0);

  // Typing again searches under the filter now chosen.
  await input.fill("quokkaclear");
  await expect(page.locator(".search-summary")).toHaveText("1 result", { timeout: 15_000 });
  await expect(page.locator(".search-result")).toContainText("someday");
});
