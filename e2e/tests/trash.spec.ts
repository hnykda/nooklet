/**
 * The trash (M7 item 8, ADR 022): a deleted page or block shows up at `/trash` with who deleted
 * it, Restore brings it back where it was, and the page reads back with its blocks. Deletions
 * come through the API (the way an agent or another device would delete); the browser does the
 * restoring, because the view and its refetch-after-write are what this spec is for.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.locator(".app-sidebar");
  if ((await sidebar.count()) === 0) {
    await page.locator("button[aria-label='Toggle sidebar']").click();
  }
  await expect(sidebar).toBeVisible();
}

// Every spec file in one `playwright test` run shares the server (global-setup starts one), so
// other specs' deletions are in this trash too. Assertions below are scoped to the rows that
// mention the page under test, never to the whole list.

test("the sidebar has a Trash entry, and the view is honest about retention", async ({ page }) => {
  await page.goto("/journals");
  await openSidebar(page);
  await page.locator(".app-sidebar .sidebar-nav a[href='/trash']").click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.locator(".trash-view h1")).toContainText("Trash");
  await expect(page.locator(".trash-note")).toContainText("Nothing expires");
});

test("a page deleted through the API is listed with its deleter, and Restore brings it back", async ({
  page,
}) => {
  await seedPage(page, "Trash Page", "- alpha\n  - beta\n- gamma");
  const del = await api<{ batch_id: string }>(page, "page.delete", { page: "Trash Page" });
  expect(typeof del.batch_id).toBe("string");

  await page.goto("/trash");
  const row = page.locator(".trash-row", { hasText: "Trash Page" });
  await expect(row).toBeVisible();
  await expect(row.locator(".trash-kind")).toHaveText("page");
  await expect(row.locator(".trash-meta")).toContainText("3 blocks");
  // Who: the web-client token's label, over the API.
  await expect(row.locator(".trash-origin")).toHaveText("api");

  await row.locator(".trash-restore").click();
  await expect(page.locator(".trash-notice")).toContainText('Restored "Trash Page"');
  await expect(page.locator(".trash-notice")).toContainText("3 blocks with it");
  await expect(row).toHaveCount(0);

  // It is really back, tree intact, as the API and the outliner both see it.
  const blocks = await readBlocks(page, "Trash Page");
  expect(blocks.map((b) => [b.content, b.depth])).toEqual([
    ["alpha", 0],
    ["beta", 1],
    ["gamma", 0],
  ]);
  await page.locator(".trash-notice-link").click();
  await expect(page).toHaveURL(/\/page\/Trash%20Page$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("beta");
});

test("a deleted block subtree is one entry on its page, and Restore puts it back in place", async ({
  page,
}) => {
  await seedPage(page, "Trash Block Page", "- keep me\n- remove me\n  - child of removed");
  const blocks = await readBlocks(page, "Trash Block Page");
  const removeId = blocks.find((b) => b.content === "remove me")?.id as string;
  await api(page, "block.delete", { id: removeId });

  await page.goto("/trash");
  // One row for the subtree, not one per block: the child would otherwise be a second row that
  // also says "on Trash Block Page".
  const rows = page.locator(".trash-row", { hasText: "Trash Block Page" });
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row.locator(".trash-kind")).toHaveText("block");
  await expect(row.locator(".trash-title")).toHaveText("remove me");
  await expect(row.locator(".trash-meta")).toContainText("on Trash Block Page");
  await expect(row.locator(".trash-meta")).toContainText("2 blocks");

  await row.locator(".trash-restore").click();
  await expect(page.locator(".trash-notice")).toContainText('Restored the block "remove me"');
  await expect(rows).toHaveCount(0);

  await page.goto(pagePath("Trash Block Page"));
  const outlinerRows = page.locator(".vr-outliner").first().locator(".vr-row");
  await expect(outlinerRows).toHaveCount(3);
  await expect(outlinerRows.nth(1)).toContainText("remove me");
  await expect(outlinerRows.nth(2)).toContainText("child of removed");
});

test("the trash view picks up a deletion made while it is open, without a reload", async ({
  page,
}) => {
  await seedPage(page, "Trash Live Page", "- soon gone");
  await page.goto("/trash");
  await expect(page.locator(".trash-row", { hasText: "Trash Live Page" })).toHaveCount(0);
  await api(page, "page.delete", { page: "Trash Live Page" });
  // The server's write reaches this replica through the live poke and pull; the view is stamped
  // on the page table, so it refetches on its own.
  await expect(page.locator(".trash-row", { hasText: "Trash Live Page" })).toBeVisible({
    timeout: 15_000,
  });
});
