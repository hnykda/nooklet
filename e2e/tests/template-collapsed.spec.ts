/**
 * B-265: a template folded in the library (`collapsed:: true`, like the owner's imported
 * "Meeting") inserted as a folded copy — one bullet, its content hidden beneath it.
 *
 * The library page is deleted when the file is done: the whole run shares one graph, and
 * `templates.spec.ts` asserts the exact list of templates Settings offers.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, openEditing, rowDepths, rowTexts, seedPage } from "../helpers/index.js";

const LIBRARY = "Template Folded Library";
const LIBRARY_MD = `- Folded meeting
  template:: folded-qa-tpl
  collapsed:: true
  type:: standup
  - Objectives:
  - Agenda:
    collapsed:: true
    - hidden agenda item`;

/** Type `/template`, take the slash menu's Template row, filter the picker, pick with Enter. */
async function pickTemplate(page: Page, name: string): Promise<void> {
  await page.keyboard.type("/template");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu).toBeVisible();
  await menu
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker = page.locator(".tpl-picker");
  await expect(picker).toBeVisible();
  await page.keyboard.type(name);
  await expect(picker.locator('[role="option"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await api(page, "page.delete", { page: LIBRARY }).catch(() => {});
  await page.close();
});

interface Node {
  content: string;
  collapsed?: boolean;
  children: Node[];
}

test("a folded template inserts unfolded, keeping folds below its top (B-265)", async ({
  page,
}) => {
  await seedPage(page, LIBRARY, LIBRARY_MD);
  const outliner = await openEditing(page, "Template Folded Target", "- start");
  await page.keyboard.press("Enter");
  await pickTemplate(page, "folded-qa-tpl");

  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  const texts = await rowTexts(page, outliner);
  expect(texts.slice(1)).toEqual([
    expect.stringContaining("Folded meeting"),
    expect.stringContaining("Objectives:"),
    expect.stringContaining("Agenda:"),
  ]);
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 1, 1]);

  // The copy reaches the server on the client's next push, so wait for its children.
  const copy = async (): Promise<Node | undefined> =>
    (
      await api<{ tree: Node[] }>(page, "page.read", {
        page: "Template Folded Target",
        format: "json",
      })
    ).tree[1];
  await expect.poll(async () => (await copy())?.children.length).toBe(2);
  expect((await copy())?.collapsed).toBe(false);
  expect((await copy())?.children[1]?.collapsed).toBe(true);
  // The library keeps its fold.
  const lib = await api<{ tree: Node[] }>(page, "page.read", { page: LIBRARY, format: "json" });
  expect(lib.tree[0]?.collapsed).toBe(true);
});
