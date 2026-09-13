/**
 * Document-level undo/redo against the real server (ADR 006, `apps/web/src/editor/history.ts`).
 *
 * `focus.spec.ts` covers undo of typed text and of one split, looking at the screen. What these
 * tests add is the other half: after every undo and redo the SERVER has to agree with the screen,
 * and a reload has to show the same thing. Exploratory QA on 2026-09-13 found three ways the two
 * came apart: a redo the server ignored, an undo that went nowhere, an undo that dropped focus.
 */

import { expect, type Page, test } from "@playwright/test";
import { MOD, openEditing, readBlocks, rowTexts } from "../helpers/index.js";

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("redo of an undone Enter puts the block back on the server, not just on screen (B-240)", async ({
  page,
}) => {
  const name = "Undo Redo Create";
  const outliner = await openEditing(page, name, "- one\n- two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("mid");
  await expect.poll(() => stored(page, name)).toEqual(["one", "mid", "two"]);

  await page.keyboard.press(`${MOD}+z`); // the typed text
  await page.keyboard.press(`${MOD}+z`); // the split: the new block is tombstoned
  await expect.poll(() => stored(page, name)).toEqual(["one", "two"]);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await page.keyboard.press(`${MOD}+Shift+z`); // the split again
  await page.keyboard.press(`${MOD}+Shift+z`); // the text again
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "mid", "two"]);
  // The redo's block.create used to be a no-op on the server (the id already existed, as a
  // tombstone) while the client's optimistic layer revived it: screen and server disagreed.
  await expect.poll(() => stored(page, name)).toEqual(["one", "mid", "two"]);

  await page.reload();
  const rows = page.locator(".vr-outliner").first().locator(".vr-row");
  await expect(rows).toHaveCount(3);
  expect(await rowTexts(page)).toEqual(["one", "mid", "two"]);
});
