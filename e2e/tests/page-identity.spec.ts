/**
 * A page answers to its aliases in the app the way it does over the API (B-104): `/page/<alias>`
 * opens the page and the URL moves to the page's own name. Before, the route looked at `page.key`
 * only and said "This page doesn't exist yet" — while `page_read` and `[[alias]]` links resolved.
 */
import { expect, test } from "@playwright/test";
import { api, pagePath, readBlocks } from "../helpers/index.js";

const REAL = "Zahrada Identity";

test.beforeEach(async ({ page }) => {
  await api(page, "page.create", {
    name: REAL,
    if_exists: "return",
    // A bare alias and a [[wrapped]] one with a comma inside — both shapes the owner's graph has.
    properties: { alias: "garden identity, [[Sad, Identity]]" },
    markdown: "- the real page, see [[Identity Onward]]",
  });
  await api(page, "page.create", {
    name: "Identity Onward",
    if_exists: "return",
    markdown: "- somewhere else",
  });
});

test("/page/<alias> opens the page and replaces the URL with its own name (B-104)", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.goto(pagePath("garden identity"));

  await expect(page).toHaveURL(new RegExp(`${pagePath(REAL)}$`));
  await expect(page.locator(".page-title-input")).toHaveValue(REAL);
  await expect(page.locator(".page-view-missing")).toHaveCount(0);

  // Replaced, not pushed: Back goes to where we came from, not to the alias (which would redirect
  // forward again and trap Back).
  await page.goBack();
  await expect(page).toHaveURL(/\/journals$/);
});

test("a [[wrapped]] alias with a comma resolves, and a zoomed block stays zoomed (B-104)", async ({
  page,
}) => {
  const [block] = await readBlocks(page, REAL);
  if (!block) throw new Error("seed page has no block");

  await page.goto(`${pagePath("Sad, Identity")}?block=${block.id}`);

  await expect(page).toHaveURL(new RegExp(`${pagePath(REAL)}\\?block=${block.id}$`));
  await expect(page.locator(".page-view-breadcrumb")).toContainText(REAL);
});

test("following [[alias]] lands on the page, and links onward from it do not bounce back (B-104)", async ({
  page,
}) => {
  await api(page, "page.create", {
    name: "Identity Source",
    if_exists: "return",
    markdown: "- go to [[garden identity]]",
  });
  await page.goto(pagePath("Identity Source"));
  await page.locator(".vr-outliner .vr-page-ref", { hasText: "garden identity" }).click();
  await expect(page).toHaveURL(new RegExp(`${pagePath(REAL)}$`));
  await expect(page.locator(".page-title-input")).toHaveValue(REAL);

  // The redirect compares the resolved page with the route; while the next page loads, the
  // resource still holds this one, and a careless comparison sends the reader straight back.
  await page.locator(".vr-outliner .vr-page-ref", { hasText: "Identity Onward" }).click();
  await expect(page.locator(".page-title-input")).toHaveValue("Identity Onward");
  await page.waitForTimeout(750);
  await expect(page).toHaveURL(new RegExp(`${pagePath("Identity Onward")}$`));
  await expect(page.locator(".page-title-input")).toHaveValue("Identity Onward");
});

test("an alias added while its URL is open turns 'does not exist' into the page (B-104)", async ({
  page,
}) => {
  // Suffixed by attempt: a CI retry would otherwise find the alias already there.
  const late = `Identity Late ${test.info().retry}`;
  const nickname = `identity nickname ${test.info().retry}`;
  await api(page, "page.create", { name: late, if_exists: "return", markdown: "- x" });
  await page.goto(pagePath(nickname));
  await expect(page.locator(".page-view-missing")).toBeVisible();

  await api(page, "page.update", { page: late, properties: { alias: nickname } });

  await expect(page).toHaveURL(new RegExp(`${pagePath(late)}$`));
  await expect(page.locator(".page-title-input")).toHaveValue(late);
});

test("a page renamed over the API still opens from its old URL (B-104)", async ({ page }) => {
  // `page.update new_name` keeps the old name as an alias, so every old link and bookmark keeps
  // working — as long as the route resolves aliases.
  const before = `Identity Before ${test.info().retry}`;
  const after = `Identity After ${test.info().retry}`;
  await api(page, "page.create", { name: before, if_exists: "return", markdown: "- y" });
  await api(page, "page.update", { page: before, new_name: after });

  await page.goto(pagePath(before));
  await expect(page).toHaveURL(new RegExp(`${pagePath(after)}$`));
  await expect(page.locator(".page-title-input")).toHaveValue(after);
});
