/**
 * B-788 on the desktop: zoomed into a block, that block is the fixed top of the view. Enter on it
 * makes its first child, which shows and takes the caret; no key moves anything out of the view.
 * The phone half is `phone-zoom-root.spec.ts`. Both run in Chromium and WebKit.
 *
 * Every assertion that something stayed put reads the SERVER's tree (`readBlocks`) as well as the
 * rows: before the fix, the new block was written fine — just outside the view.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  editor,
  openPage,
  readBlocks,
  rowDepths,
  rowTexts,
  runName,
} from "../helpers/index.js";

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

// B-820 / B-383: slash commands that CREATE blocks. Each would have put them after the zoom root,
// outside the view. The template's own top level is two blocks (`template-including-parent::
// false`), so the empty-root case has a "rest" that used to become the root's siblings.
const TEMPLATE = "zoomtpl";
const LIBRARY_MD = `- Zoom library
  template:: ${TEMPLATE}
  template-including-parent:: false
  - alpha
    - alpha kid
  - beta`;

/** Type `/template`, take the slash menu's Template row, filter the picker, pick with Enter. */
async function pickTemplate(page: Page): Promise<void> {
  await page.keyboard.type("/template");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu).toBeVisible();
  await menu
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker = page.locator(".tpl-picker");
  await expect(picker).toBeVisible();
  await page.keyboard.type(TEMPLATE);
  await expect(picker.locator('[role="option"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
}

/** Seeds the template library for one test and removes it after: `templates.spec.ts` asserts the
 * exact list of templates on the shared server. */
async function withLibrary(page: Page, body: () => Promise<void>): Promise<void> {
  const library = unique("Zoom Template Library");
  await openPage(page, library, LIBRARY_MD);
  try {
    await body();
  } finally {
    await api(page, "page.delete", { page: library });
  }
}

const stored = async (page: Page, name: string) =>
  (await readBlocks(page, name)).map((b) => [b.content.trimEnd(), b.depth]);

test("B-820: /template on a zoom root with text puts the template under it, in view", async ({
  page,
}) => {
  await withLibrary(page, async () => {
    const name = unique("Zoom Root Template");
    const outliner = await openPage(page, name, "- before\n- root\n  - kid\n- after");
    const zoomed = await zoomInto(page, outliner, 1);
    await editRow(page, zoomed, 0);
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await pickTemplate(page);

    await expect
      .poll(() => rowTexts(page, zoomed))
      .toEqual(["root ", "alpha", "alpha kid", "beta", "kid"]);
    expect(await rowDepths(page, zoomed)).toEqual([0, 1, 2, 1, 1]);
    // The caret went to the first new block, which is on screen.
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type(" typed");
    await expect(editor(page)).toHaveText("alpha typed");
    await expect
      .poll(() => stored(page, name))
      .toEqual([
        ["before", 0],
        ["root", 0],
        ["alpha typed", 1],
        ["alpha kid", 2],
        ["beta", 1],
        ["kid", 1],
        ["after", 0],
      ]);
  });
});

test("B-820: /template into an empty zoom root keeps every top-level block of it in view", async ({
  page,
}) => {
  await withLibrary(page, async () => {
    const name = unique("Zoom Root Template Empty");
    const outliner = await openPage(page, name, "- before\n- placeholder\n  - kid\n- after");
    const zoomed = await zoomInto(page, outliner, 1);
    await editRow(page, zoomed, 0);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(editor(page)).toHaveText("");
    // Let the emptied text reach the server first: inserted while that edit is still in flight,
    // the template's first line shows but the server keeps "" (B-861, a separate bug).
    await expect.poll(async () => (await readBlocks(page, name))[1]?.content).toBe("");
    await pickTemplate(page);

    await expect.poll(() => rowTexts(page, zoomed)).toEqual(["alpha", "alpha kid", "beta", "kid"]);
    expect(await rowDepths(page, zoomed)).toEqual([0, 1, 1, 1]);
    await expect
      .poll(() => stored(page, name))
      .toEqual([
        ["before", 0],
        ["alpha", 0],
        ["alpha kid", 1],
        ["beta", 1],
        ["kid", 1],
        ["after", 0],
      ]);
  });
});

test("B-383: /mermaid on a zoom root with text puts the diagram in its first child, in view", async ({
  page,
}) => {
  const STARTER = "```mermaid\ngraph TD\n  A --> B\n```";
  const name = unique("Zoom Root Mermaid");
  const outliner = await openPage(page, name, "- before\n- root\n  - kid\n- after");
  const zoomed = await zoomInto(page, outliner, 1);
  await editRow(page, zoomed, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" /merm");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toHaveText("Mermaid diagram");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);

  await expect
    .poll(() => stored(page, name), { timeout: 15_000 })
    .toEqual([
      ["before", 0],
      ["root", 0],
      [STARTER, 1],
      ["kid", 1],
      ["after", 0],
    ]);
  // In view, and the caret is in it (inside the fence, B-185): the next key goes there.
  await expect.poll(async () => await zoomed.locator(".vr-row").count()).toBe(3);
  await page.keyboard.type(" --> C");
  await expect
    .poll(async () => (await readBlocks(page, name))[2]?.content.trimEnd(), { timeout: 15_000 })
    .toBe("```mermaid\ngraph TD\n  A --> B --> C\n```");
  expect((await readBlocks(page, name))[1]?.content.trimEnd()).toBe("root");
});
