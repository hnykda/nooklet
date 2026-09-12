/**
 * Page icons: one emoji per page, stored as the `icon` property (the same one Logseq uses), set
 * from the title row and shown wherever the page is listed.
 */

import { expect, type Page, test } from "@playwright/test";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

async function openPage(page: Page, name: string): Promise<void> {
  await page.goto("/journals");
  await api(page, "page.create", { name, if_exists: "return" });
  await api(page, "page.append", { page: name, markdown: "- a block" });
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await expect(page.locator(".page-title-row")).toBeVisible();
}

test("setting an icon from the title row shows it there, in All Pages, and in favourites", async ({
  page,
}) => {
  await openPage(page, "Icon Rocket");

  // No icon yet: the affordance is a faint plus, not a blank.
  const button = page.locator(".page-icon-button");
  await expect(button).toHaveClass(/page-icon-button-empty/);
  await button.click();
  const input = page.locator(".page-icon-input");
  await expect(input).toBeFocused();
  await input.fill("🚀");
  await page.keyboard.press("Enter");

  await expect(button).toHaveText("🚀");
  await expect(button).not.toHaveClass(/page-icon-button-empty/);

  // It is a plain property, visible and editable in the properties panel too.
  await page.locator(".page-properties-toggle").click();
  await expect(
    page.locator(".page-property-row", { hasText: "icon" }).locator("input"),
  ).toHaveValue("🚀");

  await page.goto("/pages");
  const row = page.locator(".all-pages-name", { hasText: "Icon Rocket" });
  await expect(row.locator(".page-icon")).toHaveText("🚀");

  // Star it: the favourite entry in the sidebar carries the icon as well. The sidebar is closed
  // by default, so open it first — the list is not in the DOM until then.
  await row.locator("xpath=..").locator(".all-pages-star").click();
  await page.locator("[aria-label='Toggle sidebar']").click();
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar).toBeVisible();
  // Both sidebar lists carry it: the favourites section and the recent pages below it.
  const fav = sidebar.locator(".sidebar-section", { hasText: "Favourites" }).locator("a", {
    hasText: "Icon Rocket",
  });
  await expect(fav.locator(".page-icon")).toHaveText("🚀");
  const recent = sidebar.locator(".sidebar-section", { hasText: "Pages" }).locator("a", {
    hasText: "Icon Rocket",
  });
  await expect(recent.locator(".page-icon")).toHaveText("🚀");
});

test("only the first grapheme is kept, and clearing the field removes the icon", async ({
  page,
}) => {
  await openPage(page, "Icon Trim");
  await page.locator(".page-icon-button").click();
  await page.locator(".page-icon-input").fill("🇨🇿 flag then words");
  await page.keyboard.press("Enter");
  // A flag is two code points and one grapheme; it must survive whole.
  await expect(page.locator(".page-icon-button")).toHaveText("🇨🇿");

  await page.locator(".page-icon-button").click();
  await page.locator(".page-icon-input").fill("");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-icon-button")).toHaveClass(/page-icon-button-empty/);

  // Cleared means the property is gone, not stored as an empty string.
  const read = (await api(page, "page.read", { page: "Icon Trim" })) as {
    page: { properties?: Record<string, string> };
  };
  expect(read.page.properties?.icon).toBeUndefined();
});

test("an icon written as a property by an agent shows in the title row", async ({ page }) => {
  await openPage(page, "Icon Via API");
  await api(page, "page.update", { page: "Icon Via API", properties: { icon: "📚" } });
  await expect(page.locator(".page-icon-button")).toHaveText("📚");
});
