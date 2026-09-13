/**
 * The Search view's task / kind / journals filters (audit §2 #11) against the real server — which
 * is where the marker filter used to match nothing at all (B-238): the op looked for `marker` in
 * `block_prop`, and a marker lives in a `block` column.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, seedPage } from "../helpers/index.js";

async function searchFor(page: Page, query: string): Promise<void> {
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill(query);
  await expect(page.locator(".search-summary")).toBeVisible({ timeout: 15_000 });
  await page.locator(".search-filters summary").click();
}

function summary(page: Page) {
  return page.locator(".search-summary");
}

test("the task filter finds blocks by marker, and journals only narrows to journal days", async ({
  page,
}) => {
  await seedPage(
    page,
    "Filter Errands",
    "- TODO zebrafinch milk\n- DONE zebrafinch bread\n- zebrafinch eggs",
  );
  // Twenty-three days back: an offset no other spec writes to.
  await api(page, "page.append", { page: isoOffset(-23), markdown: "- LATER zebrafinch seeds" });

  await searchFor(page, "zebrafinch");
  await expect(summary(page)).toHaveText("4 results");

  await page.locator(".search-filter-marker").selectOption("TODO");
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result")).toContainText("milk");

  await page.locator(".search-filter-marker").selectOption("LATER");
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result")).toContainText("seeds");

  await page.locator(".search-filter-marker").selectOption("");
  await page.locator(".search-filter-journals").check();
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result")).toContainText("seeds");
});

test("pages only and blocks only choose what kind of hit comes back", async ({ page }) => {
  await seedPage(page, "Okapi Habitat", "- okapi sightings on the island");

  await searchFor(page, "okapi");
  await expect(summary(page)).toHaveText("2 results");

  await page.locator(".search-filter-kind").selectOption("pages");
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result-page")).toHaveText("Okapi Habitat");
  await expect(page.locator(".search-result-snippet")).not.toContainText("sightings");

  await page.locator(".search-filter-kind").selectOption("blocks");
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result-snippet")).toContainText("sightings");
});

test("choosing a task marker from pages only shows blocks only, not a pages-only label over tasks", async ({
  page,
}) => {
  // Show kept reading "Pages only" (a disabled option, still selected) over a list of task
  // blocks (verification probe, 2026-09-13).
  await seedPage(page, "Kinkajou Chores", "- TODO kinkajou feeding\n- kinkajou nap");
  await searchFor(page, "kinkajou");
  await page.locator(".search-filter-kind").selectOption("pages");
  await expect(summary(page)).toHaveText("1 result");

  await page.locator(".search-filter-marker").selectOption("TODO");
  await expect(summary(page)).toHaveText("1 result");
  await expect(page.locator(".search-result-snippet")).toContainText("feeding");
  await expect(page.locator(".search-filter-kind")).toHaveValue("blocks");
});
