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
import {
  api,
  expectEditorFocusedNow,
  isoOffset,
  pagePath,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

async function openPageView(page: Page, name: string): Promise<void> {
  await page.goto(pagePath(name));
  await expect(page.locator(".vr-outliner .vr-row").first()).toBeVisible();
}

async function chooseDeleteFromMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
}

/**
 * Run a command from the palette's commands mode (`>`), checking the row that Enter will run first.
 *
 * Commands mode, and the pointer moved out of the way first: a row rendered under a pointer that
 * never moved takes the highlight (`onMouseEnter`, B-493). After a click on the dialog's Cancel the
 * pointer rests exactly where the palette's second row appears, and in mixed mode that row was the
 * page "Delete Zebra Page" from the first test — so this failed 2 of 2 runs with "Delete Zebra
 * Page" highlighted, and Enter would have opened that page instead of running the command.
 */
async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.mouse.move(1, 1);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill(">");
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
    "Links to it from other pages will open an empty page of that name until it is restored.",
  );
  await dialog.getByRole("button", { name: "Delete page" }).click();

  await expect(page).toHaveURL(/\/journals$/);
  await expect(dialog).toHaveCount(0);
  // ADR 024: another page still links to the name, so the server makes it a page again at once —
  // an empty one. What was deleted is the page with its blocks: they are gone from it.
  await expect.poll(async () => (await readBlocks(page, name)).length).toBe(0);

  // All pages: the linking page is listed (the list has loaded), and the name is one empty page.
  await page.goto("/pages");
  const filter = page.locator(".all-pages-filter");
  await filter.fill("Delete Zebra Linker");
  await expect(page.locator(".all-pages-row")).toHaveCount(1);
  await filter.fill(name);
  await expect(page.locator(".all-pages-row")).toHaveCount(1);

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

// The keyboard path from the middle of typing: Enter, a new block, straight to the palette. Two
// things can go wrong that the tests above never exercise. The dry run could count the page
// without the block typed a moment ago, and then promise, and delete, one block too few. (This
// checks the count, not the push that makes it right: against a local server the sync gets there
// first even with `previewPageDelete`'s `forceSync` removed — tried.) And Cancel could leave the
// person somewhere other than their caret: without the dialog's popup-key claim, the global keymap
// takes Escape in the capture phase and the dialog does not close at all — also tried; this fails.
test("from the palette mid-typing: the dialog counts the block just typed, and Escape gives the caret back", async ({
  page,
}) => {
  const name = "Delete Zebra Typing";
  await seedPage(page, name, "- zebratype one");
  await openPageView(page, name);
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("zebratype two");

  await runFromPalette(page, "Delete page");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`"${name}" and its 2 blocks will be moved to the Trash.`);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await expectEditorFocusedNow(page, "after Escape on the delete dialog");
  await expect(page.locator(".vr-row-selected")).toHaveCount(0);
  await page.keyboard.type(" more");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["zebratype one", "zebratype two more"]);
});

// Two windows on one graph (a browser tab and the desktop app, say): the one that did not delete
// must not keep showing, or keep editing, a page that is in the Trash — and Restore must bring it
// back there too, with what was typed in it before the delete.
test("another window on the page follows the delete and the restore", async ({ browser }) => {
  const name = "Delete Zebra Two Windows";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await seedPage(a, name, "- zebrawin one\n  - zebrawin two");
    await openPageView(a, name);
    await openPageView(b, name);

    await b.locator(".vr-outliner .vr-block-view").first().click();
    await expect(b.locator(".cm-content")).toBeFocused();
    await b.keyboard.press("End");
    await b.keyboard.type(" typed in B");
    await expect
      .poll(async () => (await readBlocks(a, name)).map((x) => x.content))
      .toEqual(["zebrawin one typed in B", "zebrawin two"]);

    await chooseDeleteFromMenu(a);
    await a.getByRole("alertdialog").getByRole("button", { name: "Delete page" }).click();
    await expect(a).toHaveURL(/\/journals$/);
    await expect(b.locator(".page-view-missing")).toBeVisible();
    await expect(b.locator(".vr-outliner")).toHaveCount(0);

    await a.goto("/trash");
    const row = a.locator(".trash-row", { hasText: name });
    await row.locator(".trash-restore").click();
    await expect(a.locator(".trash-notice")).toContainText(`Restored "${name}"`);

    await expect(b.locator(".page-view-missing")).toHaveCount(0);
    await expect(b.locator(".vr-outliner").first()).toContainText("zebrawin one typed in B");
    await expect(b.locator(".vr-outliner").first()).toContainText("zebrawin two");
    expect((await readBlocks(a, name)).map((x) => [x.content, x.depth])).toEqual([
      ["zebrawin one typed in B", 0],
      ["zebrawin two", 1],
    ]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
