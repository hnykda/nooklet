/**
 * A page title being typed survives changes to OTHER pages (B-201).
 *
 * `PageView` resets its title draft whenever the resolved page changes, and the page lookup used to
 * hand back a new object on every refetch — which happens whenever any page row changes anywhere
 * (and, since B-104's alias lookup, any page property). Sync pulling a new journal day, or an agent
 * setting an icon, wiped a half-typed title.
 */
import { expect, test } from "@playwright/test";
import { api, pagePath } from "../helpers/index.js";

test("a half-typed page title survives other pages being created and edited (B-201)", async ({
  page,
}) => {
  // Suffixed by attempt, so a CI retry does not start from an already-set icon or page.
  const n = test.info().retry;
  await api(page, "page.create", {
    name: `Draft Title ${n}`,
    if_exists: "return",
    markdown: "- a",
  });
  await api(page, "page.create", {
    name: `Draft Other ${n}`,
    if_exists: "return",
    markdown: "- b",
  });
  await page.goto(pagePath(`Draft Title ${n}`));

  const input = page.locator(".page-title-input");
  await expect(input).toHaveValue(`Draft Title ${n}`);
  await input.click();
  await input.press("End");
  await page.keyboard.type(" renamed");
  await expect(input).toHaveValue(`Draft Title ${n} renamed`);

  // A page property changes elsewhere (what the alias lookup listens to)…
  await api(page, "page.update", { page: `Draft Other ${n}`, properties: { icon: "🌱" } });
  // …and a page row changes elsewhere (what the lookup always listened to). Both arrive over the
  // live sync poke; there is no UI signal for "the pull landed" on this page, so wait it out.
  await api(page, "page.create", { name: `Draft Third ${n}`, if_exists: "return" });
  await page.waitForTimeout(2000);
  await expect(input).toHaveValue(`Draft Title ${n} renamed`);

  // And the draft is still a real edit: committing it renames the page.
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${pagePath(`Draft Title ${n} renamed`)}$`));
});
