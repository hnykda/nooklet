/**
 * Page icons: one emoji per page, stored as the `icon` property (the same one Logseq uses), set
 * from the title row and shown wherever the page is listed.
 */

import { expect, type Page, test } from "@playwright/test";
import { pagePath, runName } from "../helpers/index.js";

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
  await page.goto(pagePath(name));
  await expect(page.locator(".page-title-row")).toBeVisible();
}

test("setting an icon from the title row shows it there, in All Pages, and in favourites", async ({
  page,
}, info) => {
  // Per repeat: the icon slot must start empty, and a second run found the first run's rocket.
  const name = runName("Icon Rocket", info);
  await openPage(page, name);

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
  const row = page.locator(".all-pages-name", { hasText: name });
  await expect(row.locator(".page-icon")).toHaveText("🚀");

  // Star it: the favourite entry in the sidebar carries the icon as well. The sidebar is closed
  // by default, so open it first — the list is not in the DOM until then.
  await row.locator("xpath=..").locator(".all-pages-star").click();
  await page.locator("[aria-label='Toggle sidebar']").click();
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar).toBeVisible();
  // Both sidebar lists carry it: the favourites section and the recent pages below it.
  const fav = sidebar.locator(".sidebar-section", { hasText: "Favourites" }).locator("a", {
    hasText: name,
  });
  await expect(fav.locator(".page-icon")).toHaveText("🚀");
  const recent = sidebar
    .locator(".sidebar-section", { has: page.locator("h2", { hasText: "Recent" }) })
    .locator("a", {
      hasText: name,
    });
  await expect(recent.locator(".page-icon")).toHaveText("🚀");
});

test("only the first grapheme is kept, and clearing the field removes the icon", async ({
  page,
}, info) => {
  const name = runName("Icon Trim", info);
  // Every push is held back a second, so a server read that does not wait for the push fails every
  // time rather than only on a slow machine. Routed before the app loads: a route added later
  // does not reach the DB worker, which is what pushes.
  await page.route("**/sync/push", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await openPage(page, name);
  await page.locator(".page-icon-button").click();
  await page.locator(".page-icon-input").fill("🇨🇿 flag then words");
  await page.keyboard.press("Enter");
  // A flag is two code points and one grapheme; it must survive whole.
  await expect(page.locator(".page-icon-button")).toHaveText("🇨🇿");

  // What the SERVER holds, polled. The title row renders from the local replica, and the server
  // hears of a change only when the client's push lands (a 300 ms debounce, then a request): one
  // read straight after the row updated raced that push, and under load found the flag still
  // there (B-356). Waiting for the flag to arrive first also keeps the "gone" check below honest —
  // it would pass trivially on a server that never heard of the flag at all.
  const serverProperties = async () => {
    const read = (await api(page, "page.read", { page: name })) as {
      page: { properties?: Record<string, string> };
    };
    return read.page.properties ?? {};
  };
  await expect.poll(serverProperties).toHaveProperty("icon", "🇨🇿");

  await page.locator(".page-icon-button").click();
  await page.locator(".page-icon-input").fill("");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-icon-button")).toHaveClass(/page-icon-button-empty/);

  // Cleared means the property is gone, not stored as an empty string.
  await expect.poll(serverProperties).not.toHaveProperty("icon");
});

test("an icon written as a property by an agent shows in the title row", async ({ page }, info) => {
  const name = runName("Icon Via API", info);
  await openPage(page, name);
  await api(page, "page.update", { page: name, properties: { icon: "📚" } });
  await expect(page.locator(".page-icon-button")).toHaveText("📚");
});
