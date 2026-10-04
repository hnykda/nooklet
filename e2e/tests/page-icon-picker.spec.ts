/**
 * The page-icon picker (B-647): typing searches emoji by name instead of becoming the icon, the
 * grid works with arrows/Enter/Escape and by touch at phone width, and "Remove" clears the icon.
 * The stored value is the same `icon` page property as before, so it is read back from the server.
 */

import { expect, type Page, test } from "@playwright/test";
import { openPage, runName } from "../helpers/index.js";

async function serverIcon(page: Page, name: string): Promise<string | undefined> {
  return page.evaluate(async (name) => {
    const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
    const res = await fetch("/api/v1/page.read", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ page: name }),
    });
    if (!res.ok) throw new Error(`page.read -> ${res.status}`);
    const read = (await res.json()) as { page: { properties?: Record<string, string> } };
    return read.page.properties?.icon;
  }, name);
}

const activeLabel = (page: Page) =>
  page.evaluate(() => {
    const id = document
      .querySelector(".emoji-picker-search")
      ?.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.getAttribute("aria-label") : null;
  });

test("search 'rocket', pick it, and it is stored as the icon property; Remove clears it", async ({
  page,
}, info) => {
  const name = runName("Picker Rocket", info);
  await openPage(page, name);
  const button = page.locator(".page-icon-button");
  await button.click();

  const search = page.locator(".emoji-picker-search");
  await expect(search).toBeFocused();
  await search.pressSequentially("rocket");
  // The search result, not the letter "r" as an icon (the B-647 report).
  const cell = page.getByRole("option", { name: "rocket", exact: true });
  await expect(cell).toBeVisible();
  await cell.click();

  await expect(page.locator(".emoji-picker")).toHaveCount(0);
  await expect(button).toHaveText("🚀");
  await expect.poll(() => serverIcon(page, name)).toBe("🚀");

  // Remove: offered only once there is an icon.
  await button.click();
  await page.getByRole("button", { name: "Remove icon" }).click();
  await expect(button).toHaveClass(/page-icon-button-empty/);
  await expect.poll(() => serverIcon(page, name)).toBeUndefined();

  // The rocket is now a recent.
  await button.click();
  await expect(
    page.locator(".emoji-picker-section", { hasText: "Recently used" }).getByRole("option"),
  ).toHaveText(["🚀"]);
});

test("keyboard: arrows move the highlight, Enter picks, Escape clears then closes", async ({
  page,
}, info) => {
  const name = runName("Picker Keys", info);
  await openPage(page, name);
  const button = page.locator(".page-icon-button");
  await button.click();
  const search = page.locator(".emoji-picker-search");
  await expect(search).toBeFocused();

  // Browsing: nothing highlighted, so Enter picks nothing; Down enters the grid at its first cell.
  await expect(page.locator(".emoji-picker-section-title").first()).toHaveText(/smileys/i);
  await page.keyboard.press("Enter");
  await expect(page.locator(".emoji-picker")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => activeLabel(page)).toBe("grinning face");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const moved = await activeLabel(page);
  expect(moved).not.toBe("grinning face");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => activeLabel(page)).toBe("grinning face");
  // Up from the top row is back in the field; keys type again.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => activeLabel(page)).toBeNull();
  await expect(search).toBeFocused();

  // A query highlights its best match; Enter takes it.
  await search.pressSequentially("red heart");
  await expect.poll(() => activeLabel(page)).toBe("red heart");
  await page.keyboard.press("Enter");
  await expect(button).toHaveText("❤️");
  await expect(button).toBeFocused();
  await expect.poll(() => serverIcon(page, name)).toBe("❤️");

  // Escape: first clears the query, then closes without changing anything.
  await page.keyboard.press("Enter"); // the focused icon button reopens the picker
  await expect(search).toBeFocused();
  await search.pressSequentially("tree");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".emoji-picker")).toHaveCount(0);
  await expect(button).toHaveText("❤️");

  // A pasted emoji is taken as itself.
  await button.click();
  await search.fill("🦊");
  await page.keyboard.press("Enter");
  await expect(button).toHaveText("🦊");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("opened from the … menu, it fits the screen and works by touch", async ({ page }, info) => {
    const name = runName("Picker Phone", info);
    await openPage(page, name);
    await page.getByRole("button", { name: "Page actions" }).tap();
    await page.getByRole("menuitem", { name: "Add icon" }).tap();

    const picker = page.locator(".emoji-picker");
    await expect(picker).toBeVisible();
    // Inside the screen, and the page did not grow sideways (cf. B-648).
    const box = await picker.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    // Cells are finger-sized.
    const cell = page.locator(".emoji-picker-cell").first();
    expect((await cell.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(36);

    // A category jump, then a tap on a cell in it.
    await page.getByRole("button", { name: "food & drink" }).tap();
    const food = page.locator(".emoji-picker-section", { hasText: "food & drink" });
    const first = food.getByRole("option").first();
    await expect(first).toBeInViewport();
    const glyph = (await first.textContent()) ?? "";
    await first.tap();
    await expect(page.locator(".page-icon-button")).toHaveText(glyph);
    await expect.poll(() => serverIcon(page, name)).toBe(glyph);

    // Search by typing works the same on a phone.
    await page.locator(".page-icon-button").tap();
    await page.locator(".emoji-picker-search").fill("rocket");
    await page.getByRole("option", { name: "rocket", exact: true }).tap();
    await expect(page.locator(".page-icon-button")).toHaveText("🚀");

    // Kept for a look by eye (test-results/<port>/…): the picker open with a recent, browsing.
    await page.locator(".page-icon-button").tap();
    await expect(page.locator(".emoji-picker-section-title").nth(1)).toHaveText(/smileys/i);
    await page.screenshot({ path: test.info().outputPath("phone-picker.png") });
  });
});
