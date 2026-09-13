/**
 * Delete page from the app (`app.deletePage`, commands-and-keymap R52b): the title row's "…" menu
 * and the palette ask in an in-page dialog, move the page and its blocks to the Trash, and go to
 * the journal. Checked where a person would look — All pages, search, the Trash — and brought back
 * with Restore, blocks and all.
 *
 * The dialog is in the page, not `window.confirm`: Chromium would show a native one and this suite
 * would pass, while the desktop app's webview answers `confirm()` with Cancel unseen (B-491). So
 * nothing here listens for a `dialog` event; a native confirm would fail these tests by never
 * showing the `alertdialog`.
 *
 * Page names start with "Delete Zebra" and the journal day is 53 days back: the suite shares one
 * server.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function openPageView(page: Page, name: string): Promise<void> {
  await page.goto(pagePath(name));
  await expect(page.locator(".vr-outliner .vr-row").first()).toBeVisible();
}

async function chooseDeleteFromMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
}

/** Run a command from the palette's commands mode, checking the row that Enter will run first. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill(title);
  await expect(palette.locator(".cmd-row--active")).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

async function pageExists(page: Page, name: string): Promise<boolean> {
  try {
    await api(page, "page.read", { page: name });
    return true;
  } catch (err) {
    if (String(err).includes("404")) return false;
    throw err;
  }
}

async function keywordSearch(page: Page, query: string): Promise<void> {
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill(query);
}

test("Delete page from the … menu: asked, gone from All pages and search, in the Trash, and Restore brings its blocks back", async ({
  page,
}) => {
  const name = "Delete Zebra Page";
  await seedPage(page, name, "- zebradel alpha\n  - zebradel beta\n- zebradel gamma");
  await seedPage(page, "Delete Zebra Linker", `- see [[${name}]]`);

  // Search finds its blocks before, so "0 results" after means the delete, not a slow index.
  await keywordSearch(page, "zebradel");
  await expect(page.locator(".search-summary")).toHaveText("3 results", { timeout: 15_000 });

  await openPageView(page, name);
  await chooseDeleteFromMenu(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Delete "${name}"?`);
  await expect(dialog).toContainText(
    `"${name}" and its 3 blocks will be moved to the Trash. You can restore them from there.`,
  );
  await expect(dialog).toContainText(
    "Links to it from other pages will point at a page that doesn't exist until it is restored.",
  );
  await dialog.getByRole("button", { name: "Delete page" }).click();

  await expect(page).toHaveURL(/\/journals$/);
  await expect(dialog).toHaveCount(0);
  expect(await pageExists(page, name)).toBe(false);

  // All pages: the page that links to it is listed (the list has loaded), the deleted one is not.
  await page.goto("/pages");
  const filter = page.locator(".all-pages-filter");
  await filter.fill("Delete Zebra Linker");
  await expect(page.locator(".all-pages-row")).toHaveCount(1);
  await filter.fill(name);
  await expect(page.locator(".all-pages-row")).toHaveCount(0);
  await expect(page.locator(".all-pages-empty")).toBeVisible();

  await keywordSearch(page, "zebradel");
  await expect(page.locator(".search-summary")).toHaveText("0 results", { timeout: 15_000 });

  // The Trash lists it as one page with its three blocks, deleted from the app over the API.
  await page.goto("/trash");
  const row = page.locator(".trash-row", { hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".trash-kind")).toHaveText("page");
  await expect(row.locator(".trash-meta")).toContainText("3 blocks");

  await row.locator(".trash-restore").click();
  await expect(page.locator(".trash-notice")).toContainText(`Restored "${name}"`);
  await expect(page.locator(".trash-notice")).toContainText("3 blocks with it");
  await expect(row).toHaveCount(0);

  const blocks = await readBlocks(page, name);
  expect(blocks.map((b) => [b.content, b.depth])).toEqual([
    ["zebradel alpha", 0],
    ["zebradel beta", 1],
    ["zebradel gamma", 0],
  ]);
  await page.locator(".trash-notice-link").click();
  await expect(page).toHaveURL(/\/page\/Delete%20Zebra%20Page$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("zebradel beta");
  await keywordSearch(page, "zebradel");
  await expect(page.locator(".search-summary")).toHaveText("3 results", { timeout: 15_000 });
});

test("Cancel, Escape and the backdrop delete nothing; from the palette, Enter confirms", async ({
  page,
}) => {
  const name = "Delete Zebra Palette";
  await seedPage(page, name, "- zebrapal only block");
  await openPageView(page, name);
  const dialog = page.getByRole("alertdialog");

  await chooseDeleteFromMenu(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await runFromPalette(page, "Delete page");
  await expect(dialog).toContainText(`"${name}" and its 1 block will be moved to the Trash.`);
  await expect(dialog).not.toContainText("Links to it");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await chooseDeleteFromMenu(page);
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);

  await expect(page).toHaveURL(/\/page\/Delete%20Zebra%20Palette$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("zebrapal only block");
  expect(await pageExists(page, name)).toBe(true);

  // The destructive button has focus, so the keyboard path is palette → Enter → Enter.
  await runFromPalette(page, "Delete page");
  await expect(dialog.getByRole("button", { name: "Delete page" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/journals$/);
  expect(await pageExists(page, name)).toBe(false);
});

test("a journal day offers no Delete, and the palette command refuses it without asking", async ({
  page,
}) => {
  const day = isoOffset(-53);
  await api(page, "page.append", { page: day, markdown: "- zebraday journal note" });
  await openPageView(page, day);

  await page.getByRole("button", { name: "Page actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy as markdown" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete page…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await runFromPalette(page, "Delete page");
  await expect(page.locator(".page-actions-notice")).toHaveText(
    "Journal days can't be deleted. Delete the blocks you don't want instead.",
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/page/${day}$`));
  expect(await pageExists(page, day)).toBe(true);
});
