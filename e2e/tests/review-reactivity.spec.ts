/**
 * Web-client reactivity and failure-path defects from the 2026-09-13 review
 * (`docs/review/2026-09-13-m7-rv-web-reactivity.md`), each driven the way it was found: through
 * the real app, a real server and a production build. Unit tests pin the mechanisms; these pin
 * what a person sees.
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

test("after visiting Trash, an open page still picks up a write made elsewhere (B-130)", async ({
  page,
}) => {
  await seedPage(page, "Reactive After Trash", "- before trash");
  await page.goto(pagePath("Reactive After Trash"));
  await expect(page.locator(".vr-outliner").first()).toContainText("before trash");

  // In-app navigation, never `goto`: a reload re-wires every listener and hides the defect, which
  // lived exactly as long as the tab did.
  await openSidebar(page);
  await page.locator(".app-sidebar .sidebar-nav a[href='/trash']").click();
  await expect(page.locator(".trash-view h1")).toContainText("Trash");
  await page.goBack();
  await expect(page.locator(".vr-outliner").first()).toContainText("before trash");

  // A write from another client (an agent over the API) reaches this replica as a pull; the page
  // tree must refetch on it.
  const [first] = await readBlocks(page, "Reactive After Trash");
  await api(page, "block.update", {
    id: first?.id,
    old_str: "before trash",
    new_str: "after trash",
  });
  await expect(page.locator(".vr-outliner").first()).toContainText("after trash", {
    timeout: 15_000,
  });
});
