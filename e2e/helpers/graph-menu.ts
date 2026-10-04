import type { Page } from "@playwright/test";

/**
 * B-709: open the graph menu, which is the left sidebar's title (the open graph's name). The
 * sidebar starts closed on every load, so it is opened first — by its own toggle, the way a person
 * gets there, on a phone (drawer) and a desktop alike.
 */
export async function openGraphMenu(page: Page): Promise<void> {
  await page.locator(".app-topbar").waitFor();
  const sidebarOpen = await page.evaluate(() => document.body.classList.contains("sidebar-open"));
  if (!sidebarOpen) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await graphMenuTitle(page).click();
}

/** The sidebar's title button: "<graph name>, switch graph". */
export function graphMenuTitle(page: Page) {
  return page.getByRole("button", { name: /, switch graph$/ });
}
