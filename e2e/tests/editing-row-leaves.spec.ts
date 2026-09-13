/**
 * B-88: the row holding the editor goes when its block leaves the page — deleted or moved by
 * another device, an agent, or one of this app's own server-side refactors — instead of staying on
 * screen with the old text until the next click. The writes here come through the API, the way
 * any other device's would, and reach the open page through the live poke and pull.
 *
 * What must NOT go: a block this tab just created and the database has not caught up with. That
 * case is what the tree keeps an absent editing row for; `focus.spec.ts` covers it (Enter, then
 * typing straight away).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, clickRow, openEditing, readBlocks, rowTexts, seedPage } from "../helpers/index.js";

/**
 * The write reached this page — the child, whose row does NOT hold the editor, is gone — and then
 * the editor has left the outliner entirely, not just lost focus. The first half is what tells
 * this bug apart from a pull that never arrived: before the fix the child went and the edited row
 * stayed.
 */
async function expectRowLeft(page: Page, outliner: Locator): Promise<void> {
  await expect.poll(() => rowTexts(page, outliner), { timeout: 15_000 }).not.toContain("child");
  await expect(outliner.locator(".cm-content")).toHaveCount(0);
}

async function idOf(page: Page, pageName: string, content: string): Promise<string> {
  const block = (await readBlocks(page, pageName)).find((b) => b.content === content);
  if (!block) throw new Error(`no block "${content}" on ${pageName}`);
  return block.id;
}

test("a block deleted elsewhere while the caret is in it leaves the page", async ({ page }) => {
  const name = "Row Leaves Delete";
  const outliner = await openEditing(page, name, "- keep\n- goes\n  - child");
  await clickRow(page, outliner, 1);
  const id = await idOf(page, name, "goes");

  await api(page, "block.delete", { id });

  await expectRowLeft(page, outliner);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["keep"]);
});

test("a block moved to another page while the caret is in it leaves, and what was typed goes with it", async ({
  page,
}) => {
  const name = "Row Leaves Move Src";
  const dst = "Row Leaves Move Dst";
  await seedPage(page, dst, "- already here");
  const outliner = await openEditing(page, name, "- keep\n- goes\n  - child");
  await clickRow(page, outliner, 1);
  const id = await idOf(page, name, "goes");
  await page.keyboard.press("End");
  // Inside the 500 ms write debounce: the text is not written yet when the move lands.
  await page.keyboard.type(" typed");

  await api(page, "block.move_to_page", { id, page: dst });

  await expectRowLeft(page, outliner);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["keep"]);
  await expect
    .poll(async () => (await readBlocks(page, dst)).map((b) => [b.content, b.depth]), {
      timeout: 15_000,
    })
    .toEqual([
      ["already here", 0],
      ["goes typed", 0],
      ["child", 1],
    ]);
});
