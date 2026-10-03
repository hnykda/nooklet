/**
 * The linked-references filter and sort (M7, research/13 §4.2 item 5): the popover lists the
 * other pages the referencing blocks mention, one click includes, a second excludes, the count on
 * the heading follows the filter, and the choice comes back after a reload — per device, in
 * localStorage (ADR: reference filters are per device), which is why this needs a real browser.
 */
import { expect, type Page, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

const TARGET = "Filt Target";

/** Three referencing pages, seeded in a fixed order so "most recent first" is Gamma, Beta, Alpha. */
async function seedGraph(page: Page): Promise<void> {
  await seedPage(page, TARGET, "- the target");
  await seedPage(page, "Filt Alpha", "- see [[Filt Target]] with [[Filt Aurora]]");
  await seedPage(page, "Filt Beta", "- [[Filt Target]] and #filtdone");
  await seedPage(page, "Filt Gamma", "- plain [[Filt Target]]");
}

function linked(page: Page) {
  return page.locator(".linked-references");
}

function groupNames(page: Page) {
  return linked(page).locator(".reference-group-page");
}

test("the filter popover includes, then excludes, and the count follows", async ({ page }) => {
  await seedGraph(page);
  await page.goto(pagePath(TARGET));

  const section = linked(page);
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("3");
  await expect(groupNames(page)).toHaveCount(3);

  await section.getByRole("button", { name: "Filter linked references" }).click();
  const popover = page.getByRole("dialog", { name: "Filter linked references" });
  await expect(popover).toBeVisible();
  // Every other page the three blocks mention: their own pages, the link, the tag.
  for (const name of ["Filt Alpha", "Filt Aurora", "Filt Beta", "Filt Gamma", "filtdone"]) {
    await expect(popover.locator(".references-filter-option", { hasText: name })).toBeVisible();
  }
  // The page itself is not offered: every linked block mentions it by definition.
  await expect(
    popover.locator(".references-filter-option", { hasText: /^Filt Target/ }),
  ).toHaveCount(0);

  // Include: only the block that also mentions Aurora.
  const aurora = popover.locator(".references-filter-option", { hasText: "Filt Aurora" });
  await aurora.click();
  await expect(aurora).toHaveAttribute("data-state", "include");
  // Filtered, the heading reads as Logseq's does: "F of T" (refs-count).
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("1 of 3");
  await expect(groupNames(page)).toHaveText(["Filt Alpha"]);

  // Exclude: everything but that block.
  await aurora.click();
  await expect(aurora).toHaveAttribute("data-state", "exclude");
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("2 of 3");
  await expect(groupNames(page)).toHaveCount(2);
  await expect(groupNames(page)).not.toContainText(["Filt Alpha"]);

  // Escape closes the popover; the chip stays and the count with it.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  const chip = section.locator(".references-chip", { hasText: "Filt Aurora" });
  await expect(chip).toHaveAttribute("data-state", "exclude");
  await expect(section.getByRole("button", { name: "Filter linked references" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Remembered per page across a reload (localStorage, this device only).
  await page.reload();
  await expect(linked(page).locator(".references-toggle .reference-count")).toHaveText("2 of 3");
  await expect(linked(page).locator(".references-chip", { hasText: "Filt Aurora" })).toBeVisible();

  // The chip's own click removes it.
  await linked(page).locator(".references-chip", { hasText: "Filt Aurora" }).click();
  await expect(linked(page).locator(".references-toggle .reference-count")).toHaveText("3");
  await expect(linked(page).locator(".references-chip")).toHaveCount(0);
});

test("a filter that matches nothing says so instead of hiding the section", async ({ page }) => {
  await seedGraph(page);
  await page.goto(pagePath(TARGET));
  const section = linked(page);
  await section.getByRole("button", { name: "Filter linked references" }).click();
  const popover = page.getByRole("dialog", { name: "Filter linked references" });
  // Aurora AND filtdone: no single block mentions both.
  await popover.locator(".references-filter-option", { hasText: "Filt Aurora" }).click();
  await popover.locator(".references-filter-option", { hasText: "filtdone" }).click();
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("0 of 3");
  await expect(section.locator(".references-empty")).toContainText("No references match");

  await popover.getByRole("button", { name: "Clear filter" }).click();
  await expect(section.locator(".references-toggle .reference-count")).toHaveText("3");
});

test("the sort toggles between most recent and page name, and is remembered", async ({ page }) => {
  await seedGraph(page);
  await page.goto(pagePath(TARGET));

  // Default: most recently updated page first — the last one seeded.
  await expect(groupNames(page)).toHaveText(["Filt Gamma", "Filt Beta", "Filt Alpha"]);

  await linked(page)
    .getByRole("button", { name: /Sorted by most recent/ })
    .click();
  await expect(groupNames(page)).toHaveText(["Filt Alpha", "Filt Beta", "Filt Gamma"]);

  await page.reload();
  await expect(groupNames(page)).toHaveText(["Filt Alpha", "Filt Beta", "Filt Gamma"]);
  await linked(page)
    .getByRole("button", { name: /Sorted by page name/ })
    .click();
  await expect(groupNames(page)).toHaveText(["Filt Gamma", "Filt Beta", "Filt Alpha"]);
});
