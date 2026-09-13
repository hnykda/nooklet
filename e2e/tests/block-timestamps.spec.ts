/**
 * Block timestamps in the bullet context menu (audit §2 #15, B-230). The formatting is unit-tested
 * (`apps/web/src/app/block-times.test.ts`); this proves the line is actually wired to the replica
 * row of the block that was right-clicked, that a text edit moves "Edited", and that pressing on
 * the line does not cost the editor its focus.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  clickRow,
  editingRowIndex,
  editor,
  expectEditorFocusedNow,
  openEditing,
} from "../helpers/index.js";

function meta(page: Page): Locator {
  return page.locator(".ctx-menu .ctx-meta");
}

async function openMenuOn(page: Page, outliner: Locator, rowIndex: number): Promise<void> {
  await outliner.locator(".vr-row").nth(rowIndex).click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
}

test("the context menu shows when the block was created, and Edited once its text changes", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Timestamps Created Edited", "- untouched\n- to edit");

  await openMenuOn(page, outliner, 1);
  await expect(meta(page)).toHaveText("Created just now");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);

  // Type into row 1, then move the editor to row 0 so the edit commits as a `block.text` op.
  await page.keyboard.type(" now");
  await clickRow(page, outliner, 0);

  await openMenuOn(page, outliner, 1);
  await expect(meta(page)).toHaveText("Created just now · Edited just now");
  // The exact times ride along as a tooltip.
  await expect(meta(page)).toHaveAttribute("title", /^Created .+\nEdited .+$/);
  await page.keyboard.press("Escape");

  // The OTHER block's line is its own: never edited, so no "Edited".
  await openMenuOn(page, outliner, 0);
  await expect(meta(page)).toHaveText("Created just now");
  await page.keyboard.press("Escape");
});

test("pressing on the timestamp line keeps the menu open and the editor focused", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Timestamps Focus", "- one\n- two");
  await openMenuOn(page, outliner, 1);
  await meta(page).click();
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expectEditorFocusedNow(page, "after pressing on the context menu's timestamp line");
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("two!");
});
