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

test("renaming a page from its title after an alias redirect stays on it, and the alias still finds it (B-104)", async ({
  page,
}) => {
  // Two navigations race here: the title commit's own "follow the rename" (B-78) and the alias
  // redirect, which re-evaluates whenever the page row changes. Either landing on the old name, or
  // the redirect firing against the pre-rename route, would leave the view on a name that no
  // longer resolves — or bounce between the two.
  const n = test.info().retry;
  const before = `Alias Rename Before ${n}`;
  const after = `Alias Rename After ${n}`;
  const nick = `alias rename nick ${n}`;
  await api(page, "page.create", {
    name: before,
    if_exists: "return",
    properties: { alias: nick },
    markdown: "- kept body",
  });
  await page.goto("/journals");
  await page.goto(pagePath(nick));
  await expect(page).toHaveURL(new RegExp(`${pagePath(before)}$`));

  const title = page.locator(".page-title-input");
  await expect(title).toHaveValue(before);
  await title.fill(after);
  await title.press("Enter");

  await expect(page).toHaveURL(new RegExp(`${pagePath(after)}$`));
  await expect(title).toHaveValue(after);
  await page.waitForTimeout(750);
  await expect(page).toHaveURL(new RegExp(`${pagePath(after)}$`));
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  expect((await readBlocks(page, after)).map((b) => b.content)).toEqual(["kept body"]);

  // Both hops replaced their entry, so Back skips the alias and the old name alike.
  await page.goBack();
  await expect(page).toHaveURL(/\/journals$/);

  // The rename did not touch `alias::`, so the nickname still leads to the page.
  await page.goto(pagePath(nick));
  await expect(page).toHaveURL(new RegExp(`${pagePath(after)}$`));
  await expect(title).toHaveValue(after);
});

test("an alias two pages claim moves to the survivor when its page is deleted, without bouncing the open view (B-104)", async ({
  page,
}) => {
  const n = test.info().retry;
  const nick = `contested nick ${n}`;
  const names = [`Contested One ${n}`, `Contested Two ${n}`];
  for (const name of names) {
    await api(page, "page.create", {
      name,
      if_exists: "return",
      properties: { alias: nick },
      markdown: `- body of ${name}`,
    });
  }
  await page.goto(pagePath(nick));
  const title = page.locator(".page-title-input");
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(title).toHaveValue(new RegExp(`^Contested (One|Two) ${n}$`));
  // Which claimant wins is an arbitrary rule (see apps/web/src/data/page-alias.ts); what matters
  // is that the route settled on one of them.
  const winner = await title.inputValue();
  const survivor = names.find((x) => x !== winner) as string;
  await expect(page).toHaveURL(new RegExp(`${pagePath(winner)}$`));

  // Deleting the open page: the view says so where it is, rather than chasing the alias to the
  // other claimant — the URL names the deleted page, not the alias.
  await api(page, "page.delete", { page: winner });
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page).toHaveURL(new RegExp(`${pagePath(winner)}$`));

  await page.goto(pagePath(nick));
  await expect(page).toHaveURL(new RegExp(`${pagePath(survivor)}$`));
  await expect(title).toHaveValue(survivor);
});
