/**
 * B-788 on the desktop: zoomed into a block, that block is the fixed top of the view. Enter on it
 * makes its first child, which shows and takes the caret; no key moves anything out of the view.
 * The phone half is `phone-zoom-root.spec.ts`. Both run in Chromium and WebKit.
 *
 * Every assertion that something stayed put reads the SERVER's tree (`readBlocks`) as well as the
 * rows: before the fix, the new block was written fine — just outside the view.
 *
 * Also: `/template` and `/mermaid` on the root (B-820, B-383) and the root drawn as the view's title
 * without moving the caret (B-821).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  editingRowIndex,
  editor,
  openPage,
  readBlocks,
  rowDepths,
  rowTexts,
  runName,
} from "../helpers/index.js";
import { centreY, charBox, fontSize, lineHeight } from "../helpers/text-geometry.js";

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

// B-821: the zoom root is the view's title — drawn larger, and still edited exactly where it is
// drawn. A larger font on the row that hosts the editor is what could go wrong: the caret, the
// bullet and marker beside the first line, the text jumping when the row is clicked.

test("B-821: the zoom root is drawn at title size, with its bullet and marker on its first line", async ({
  page,
}) => {
  const name = unique("Zoom Root Title");
  const outliner = await openPage(page, name, "- body row\n- TODO garden plan\n  - kid\n- after");
  const body = await fontSize(outliner.locator(".vr-row").first().locator(".vr-block-view"));
  const zoomed = await zoomInto(page, outliner, 1);
  const root = zoomed.locator(".vr-row").first();
  const kid = zoomed.locator(".vr-row").nth(1);
  await expect(root).toHaveClass(/vr-row-zoom-root/);

  // Larger than the body; its children are body size.
  const title = await fontSize(root.locator(".vr-block-view"));
  expect(title).toBeGreaterThanOrEqual(body * 1.2);
  expect(await fontSize(kid.locator(".vr-block-view"))).toBe(body);

  // Bullet and marker are centred on the title's first line (within 2px), as on a body row.
  const first = await charBox(root, 0);
  const lineMid = (first.top + first.bottom) / 2;
  expect(Math.abs((await centreY(root.locator(".vr-bullet-dot"))) - lineMid)).toBeLessThan(2);
  expect(Math.abs((await centreY(root.locator(".vr-marker svg"))) - lineMid)).toBeLessThan(2);
  // The marker grew with the text.
  const rootIcon = (await root.locator(".vr-marker svg").boundingBox())?.height ?? 0;
  expect(rootIcon).toBeGreaterThan(body * 1.1 * 1.15);
});

test("B-821: a heading zoom root is drawn at the title size, as the editor draws it", async ({
  page,
}) => {
  const name = unique("Zoom Root Title Heading");
  const outliner = await openPage(page, name, "- before\n- ## Garden heading\n  - kid\n- after");
  const zoomed = await zoomInto(page, outliner, 1);
  const root = zoomed.locator(".vr-row").first();
  // Not 1.25 × the title: in the root the heading IS the title.
  const title = await fontSize(root);
  expect(await fontSize(root.locator("h2.vr-heading"))).toBe(title);
  const drawn = await charBox(root, 0);
  await root.locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  // The editor shows `## ` before the text; the first letter of the title keeps its size.
  const edited = await charBox(root, 3);
  expect(Math.abs(edited.height - drawn.height)).toBeLessThan(1.5);
});

test("B-821: clicking the zoom root edits it in place: the text does not move, the caret lands where clicked", async ({
  page,
}) => {
  const text = "Plan the garden beds for spring";
  const name = unique("Zoom Root Title Caret");
  const outliner = await openPage(page, name, `- before\n- ${text}\n  - kid\n- after`);
  const zoomed = await zoomInto(page, outliner, 1);
  const root = zoomed.locator(".vr-row").first();

  // Click just past the last character: the caret is at the end, and typing appends.
  const drawnFirst = await charBox(root, 0);
  const drawnLast = await charBox(root, -1);
  await page.mouse.click(drawnLast.right + 3, (drawnLast.top + drawnLast.bottom) / 2);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => caret(page)).toEqual({ anchor: text.length, head: text.length });
  // The editor draws the text exactly where the rendered view did (no jump on click).
  const editFirst = await charBox(root, 0);
  const editLast = await charBox(root, -1);
  for (const [a, b] of [
    [drawnFirst, editFirst],
    [drawnLast, editLast],
  ] as const) {
    expect(Math.abs(a.left - b.left)).toBeLessThan(1.5);
    expect(Math.abs(a.top - b.top)).toBeLessThan(1.5);
    expect(Math.abs(a.height - b.height)).toBeLessThan(1.5);
  }
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText(`${text}!`);

  // A click on the left part of a character in the middle puts the caret before it.
  const at = text.indexOf("garden");
  const g = await charBox(root, at);
  await page.mouse.click(g.left + (g.right - g.left) * 0.25, (g.top + g.bottom) / 2);
  await expect.poll(() => caret(page)).toEqual({ anchor: at, head: at });
  await page.keyboard.type("X");
  await expect(editor(page)).toHaveText(`Plan the Xgarden beds for spring!`);
});

test("B-821: arrow keys walk a wrapped zoom root line by line, then into its first child", async ({
  page,
}) => {
  const text =
    "A rather long zoom root whose text wraps onto several lines of the view, so that the caret " +
    "has to move between visual lines of the larger title text when the arrow keys are pressed";
  const name = unique("Zoom Root Title Arrows");
  const outliner = await openPage(page, name, `- before\n- ${text}\n  - kid\n- after`);
  const zoomed = await zoomInto(page, outliner, 1);
  const root = zoomed.locator(".vr-row").first();
  await editRow(page, zoomed, 0);
  await page.keyboard.press("Home");
  await page.keyboard.press("ControlOrMeta+Home");

  // How many visual lines the title takes, from where its first and last characters are.
  const first = await charBox(root, 0);
  const last = await charBox(root, -1);
  const lead = await lineHeight(root.locator(".cm-line").first());
  const lines = Math.round((last.top - first.top) / lead) + 1;
  expect(lines).toBeGreaterThanOrEqual(2);

  let previous = 0;
  for (let i = 1; i < lines; i++) {
    await page.keyboard.press("ArrowDown");
    // Still in the title, one visual line further down.
    expect(await editingRowIndex(page, zoomed)).toBe(0);
    const head = (await caret(page)).head;
    expect(head).toBeGreaterThan(previous);
    previous = head;
  }
  // Off the last line: into the first child.
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => editingRowIndex(page, zoomed)).toBe(1);
  await expect(editor(page)).toHaveText("kid");
  // And back up: onto the title's LAST line.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => editingRowIndex(page, zoomed)).toBe(0);
  expect((await caret(page)).head).toBeGreaterThan(text.length - 60);
});
