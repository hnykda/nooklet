/**
 * Restoring a trashed page whose name a live page has since taken (QA finding Q5,
 * docs/bugs-inbox/qafix-views.md B-255). `trash.restore` refuses with `conflict` and accepts
 * `new_name`; the view used to show the refusal and nothing else, so the row was a dead end.
 */

import { expect, test } from "@playwright/test";
import { api, readBlocks, seedPage } from "../helpers/index.js";

test("a restore refused because the name is taken offers to restore under another name", async ({
  page,
}) => {
  await seedPage(page, "Trash Clash", "- original one\n- original two");
  await api(page, "page.delete", { page: "Trash Clash" });
  await seedPage(page, "Trash Clash", "- the new page");

  await page.goto("/trash");
  const row = page.locator(".trash-row", { hasText: "Trash Clash" });
  await expect(row).toHaveCount(1);
  await row.locator(".trash-restore").click();

  const form = row.locator(".trash-rename");
  await expect(form).toBeVisible();
  await expect(form).toContainText('a live page is already named "Trash Clash"');
  const field = form.locator(".trash-rename-input");
  await expect(field).toHaveValue("Trash Clash (restored)");

  // The suggested name is taken as well: the form says so and stays.
  await seedPage(page, "Trash Clash Taken", "- also live");
  await field.fill("Trash Clash Taken");
  await form.locator(".trash-rename-submit").click();
  await expect(form).toContainText('a live page is already named "Trash Clash Taken"');

  await field.fill("Trash Clash (old)");
  await form.locator(".trash-rename-submit").click();
  await expect(page.locator(".trash-notice")).toContainText('Restored "Trash Clash (old)"');
  await expect(row).toHaveCount(0);

  expect((await readBlocks(page, "Trash Clash (old)")).map((b) => b.content)).toEqual([
    "original one",
    "original two",
  ]);
  expect((await readBlocks(page, "Trash Clash")).map((b) => b.content)).toEqual(["the new page"]);
});

test("Cancel closes the rename form and leaves the row in the trash", async ({ page }) => {
  await seedPage(page, "Trash Clash Cancel", "- old");
  await api(page, "page.delete", { page: "Trash Clash Cancel" });
  await seedPage(page, "Trash Clash Cancel", "- new");

  await page.goto("/trash");
  const row = page.locator(".trash-row", { hasText: "Trash Clash Cancel" });
  await row.locator(".trash-restore").click();
  await expect(row.locator(".trash-rename")).toBeVisible();
  await row.locator(".trash-rename-cancel").click();
  await expect(row.locator(".trash-rename")).toHaveCount(0);
  await expect(row).toHaveCount(1);
});

test("a name another page uses as an alias is refused the same way, with the reason (B-256)", async ({
  page,
}) => {
  await seedPage(page, "Trash Alias Nick", "- the old nickname page");
  await api(page, "page.delete", { page: "Trash Alias Nick" });
  await api(page, "page.create", {
    name: "Trash Alias Real",
    properties: { alias: "Trash Alias Nick" },
    markdown: "- the real page",
    if_exists: "return",
  });

  await page.goto("/trash");
  const row = page.locator(".trash-row", { hasText: "Trash Alias Nick" });
  await row.locator(".trash-restore").click();
  const form = row.locator(".trash-rename");
  await expect(form).toContainText(
    'a live page, "Trash Alias Real", uses "Trash Alias Nick" as an alias',
  );
  await form.locator(".trash-rename-submit").click();
  await expect(page.locator(".trash-notice")).toContainText(
    'Restored "Trash Alias Nick (restored)"',
  );
  // The alias still reaches the real page.
  const read = await api<{ page: { name: string } }>(page, "page.read", {
    page: "Trash Alias Nick",
  });
  expect(read.page.name).toBe("Trash Alias Real");
});
