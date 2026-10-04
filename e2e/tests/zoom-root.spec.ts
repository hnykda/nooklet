/**
 * B-788 on the desktop: zoomed into a block, that block is the fixed top of the view. Enter on it
 * makes its first child, which shows and takes the caret; no key moves anything out of the view.
 * The phone half is `phone-zoom-root.spec.ts`. Both run in Chromium and WebKit.
 *
 * Every assertion that something stayed put reads the SERVER's tree (`readBlocks`) as well as the
 * rows: before the fix, the new block was written fine — just outside the view.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { editor, openPage, readBlocks, rowDepths, rowTexts, runName } from "../helpers/index.js";

/** `base` made unique per project, repeat and retry: both engines run this file against one
 * server, and a page the other engine already typed into would start with its keystrokes. */
function unique(base: string): string {
  const info = test.info();
  return `${runName(base, info)} ${info.project.name}`;
}

async function zoomInto(page: Page, outliner: Locator, index: number): Promise<Locator> {
  const row = outliner.locator(".vr-row").nth(index);
  await row.hover();
  await row.getByRole("button", { name: "Zoom into block" }).click();
  await expect(page.locator(".vr-zoom-trail")).toBeVisible();
  return page.locator(".vr-outliner").first();
}

async function editRow(page: Page, outliner: Locator, index: number): Promise<void> {
  await outliner.locator(".vr-row").nth(index).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
}

test("B-788: zoomed into a leaf, Enter makes a child that shows and takes the typing", async ({
  page,
}) => {
  const name = unique("Zoom Root Enter");
  const outliner = await openPage(page, name, "- before\n- leaf\n- after");
  const zoomed = await zoomInto(page, outliner, 1);
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["leaf"]);

  await editRow(page, zoomed, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.keyboard.press("Enter");
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["leaf typed", ""]);
  expect(await rowDepths(page, zoomed)).toEqual([0, 1]);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("first child");
  await expect(editor(page)).toHaveText("first child");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second child");
  await expect
    .poll(() => rowTexts(page, zoomed))
    .toEqual(["leaf typed", "first child", "second child"]);

  // Written under the leaf, and nothing outside it moved.
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => [b.content, b.depth]))
    .toEqual([
      ["before", 0],
      ["leaf typed", 0],
      ["first child", 1],
      ["second child", 1],
      ["after", 0],
    ]);
});

test("B-788: Enter in the middle of the zoom root moves the rest of its text into a first child", async ({
  page,
}) => {
  const name = unique("Zoom Root Split");
  // Collapsed on the page: zoomed in, the root is open anyway, and Enter on a collapsed block —
  // a sibling everywhere else — is still the root's first child.
  const outliner = await openPage(
    page,
    name,
    "- before\n- head tail\n  collapsed:: true\n  - kid\n- after",
  );
  const zoomed = await zoomInto(page, outliner, 1);
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["head tail", "kid"]);
  await editRow(page, zoomed, 0);
  await page.keyboard.press("End");
  for (let i = 0; i < " tail".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["head", " tail", "kid"]);
  expect(await rowDepths(page, zoomed)).toEqual([0, 1, 1]);
  await expect(editor(page)).toBeFocused();
});

test("B-788: no key moves anything out of the zoomed view", async ({ page }) => {
  const name = unique("Zoom Root Keys");
  const outliner = await openPage(page, name, "- before\n- root\n  - one\n  - two\n- after");
  const zoomed = await zoomInto(page, outliner, 1);
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["root", "one", "two"]);
  const unchanged = [
    ["before", 0],
    ["root", 0],
    ["one", 1],
    ["two", 1],
    ["after", 0],
  ];

  // On the root: Tab, Shift+Tab, Alt+Up/Down, Backspace at its start, ArrowUp off its top.
  await editRow(page, zoomed, 0);
  await page.keyboard.press("Home");
  for (const key of ["Tab", "Shift+Tab", "Alt+ArrowUp", "Alt+ArrowDown", "Backspace", "ArrowUp"]) {
    await page.keyboard.press(key);
  }
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("root");

  // On a direct child: Shift+Tab would put it beside the root.
  await editRow(page, zoomed, 1);
  await page.keyboard.press("Shift+Tab");
  // On the last visible block: Delete at its end would pull in "after".
  await editRow(page, zoomed, 2);
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");

  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["root", "one", "two"]);
  expect(await rowDepths(page, zoomed)).toEqual([0, 1, 1]);
  // Give any write a moment to land before reading the server: these keys must write nothing.
  await page.waitForTimeout(700);
  expect((await readBlocks(page, name)).map((b) => [b.content, b.depth])).toEqual(unchanged);
});
