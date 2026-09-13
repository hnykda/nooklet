/**
 * B-190: redo of an undone structural command that CREATED blocks must write them again, not just
 * show them. The screen is the optimistic tree, so every assertion here that matters is on the
 * graph — through the API — and on a reload, which shows only what the replica really holds.
 */

import { expect, test } from "@playwright/test";
import { editor, MOD, openEditing, pagePath, readBlocks, rowTexts } from "../helpers/index.js";

test("redo after undoing Enter brings the new block back in the database, not only on screen", async ({
  page,
}) => {
  const name = "Redo Split";
  const outliner = await openEditing(page, name, "- first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first", "second"]);

  await page.keyboard.press(`${MOD}+z`); // the typed text
  await page.keyboard.press(`${MOD}+z`); // the split
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first"]);

  await page.keyboard.press(`${MOD}+Shift+z`); // the split
  await page.keyboard.press(`${MOD}+Shift+z`); // the typed text
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["first", "second"]);
  await expect(editor(page)).toHaveText("second");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first", "second"]);

  // And it survives a reload — the replica, not the optimistic tree, is what renders now.
  await page.goto(pagePath(name));
  await expect.poll(() => rowTexts(page)).toEqual(["first", "second"]);
});
