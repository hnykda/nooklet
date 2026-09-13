/**
 * Alt+Enter ("Follow link under cursor") while editing, then typing at once (B-295). The page being
 * left stays mounted until the route has resolved the new page, and its editor kept focus through
 * that gap, so what was typed went into the block being left — and was saved there, on a page no
 * longer on screen. The palette form of the same thing was B-293. Page names start with "Follow
 * Typing" — no other spec uses them.
 */

import { expect, type Page, test } from "@playwright/test";
import { activeElement, openEditing, readBlocks, seedPage } from "../helpers/index.js";

/** Plain text first: `openEditing` clicks the middle of the block, which must not be the link. */
const PAD = "plain words to click on before the link ".repeat(3);

/** End walks one wrap point at a time on a wrapped line; walk to the block's real end. */
async function toBlockEnd(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) await page.keyboard.press("End");
}

async function contents(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("Alt+Enter on a [[link]], then typing at once: nothing lands in the block being left (B-295)", async ({
  page,
}) => {
  const target = "Follow Typing Target";
  const from = "Follow Typing From Link";
  await seedPage(page, target, "- over there");
  await openEditing(page, from, `- ${PAD}[[${target}]]`);
  await toBlockEnd(page);
  await page.keyboard.press("Alt+Enter");
  expect(await activeElement(page), "focus straight after Alt+Enter").not.toContain("cm-content");
  await page.keyboard.type("qq");
  await expect(page).toHaveURL(/\/page\/follow%20typing%20target$/i);
  await page.waitForTimeout(900);
  expect(await contents(page, from)).toEqual([`${PAD}[[${target}]]`]);
  expect(await contents(page, target)).toEqual(["over there"]);
});

test("Alt+Enter on a ((block ref)), then typing at once: nothing lands in the block being left (B-295)", async ({
  page,
}) => {
  const target = "Follow Typing Ref Target";
  const from = "Follow Typing From Ref";
  await seedPage(page, target, "- the referenced block");
  const [ref] = await readBlocks(page, target);
  await openEditing(page, from, `- ${PAD}((${ref?.id}))`);
  await toBlockEnd(page);
  await page.keyboard.press("Alt+Enter");
  expect(await activeElement(page), "focus straight after Alt+Enter").not.toContain("cm-content");
  await page.keyboard.type("qq");
  await expect(page).toHaveURL(new RegExp(`\\?block=${ref?.id}$`));
  await page.waitForTimeout(900);
  expect(await contents(page, from)).toEqual([`${PAD}((${ref?.id}))`]);
  expect(await contents(page, target)).toEqual(["the referenced block"]);
});
