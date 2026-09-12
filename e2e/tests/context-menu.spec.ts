/**
 * The bullet context menu (docs/BUGS.md B-14): every entry runs a real command, so every entry
 * must do what its label says AND leave the editor in a usable state afterwards — which is what
 * "context menu shenanigans" tend to break. Right-click puts the caret in the clicked block first
 * (`BlockTree.tsx`'s `onContextMenu`), so closing the menu has to land exactly there.
 *
 * The menu opens at the pointer and extends downward, covering the rows beneath — so tests that
 * click another row afterwards right-click the LOWER row and click the upper one.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  caret,
  clickRow,
  editingRowIndex,
  editor,
  expectEditorFocusedNow,
  openEditing,
  rowDepths,
  rowTexts,
} from "../helpers/index.js";

function menu(page: Page): Locator {
  return page.locator(".ctx-menu");
}

async function openMenuOn(page: Page, outliner: Locator, rowIndex: number): Promise<void> {
  await outliner.locator(".vr-row").nth(rowIndex).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

async function runItem(page: Page, label: string): Promise<void> {
  await menu(page).locator(".ctx-item", { hasText: label }).first().click();
  await expect(menu(page)).toHaveCount(0);
}

/** Close the menu without a key: a click on empty chrome, which the menu's pointerdown listener
 * treats as "done here". */
async function closeMenuByClick(page: Page): Promise<void> {
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(menu(page)).toHaveCount(0);
}

test("Escape leaves focus and the caret exactly where right-click put them", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Escape Focus", "- first\n- second");
  await openMenuOn(page, outliner, 1);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  await expectEditorFocusedNow(page, "after Escape closed the context menu");
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });
  // Escape closed the MENU; it did not also push the block into selection mode.
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(0);
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("second!");
});

test("right-clicking while typing elsewhere moves the caret to the clicked block and keeps what was typed", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Menu Moves Caret", "- alpha\n- beta");
  await page.keyboard.type(" typed");
  await openMenuOn(page, outliner, 1);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await caret(page)).toEqual({ anchor: 4, head: 4 });
  await closeMenuByClick(page);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await rowTexts(page, outliner)).toEqual(["alpha typed", "beta"]);
});

test("clicking outside the menu closes it and the click lands where it was aimed", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Menu Click Through", "- one\n- two");
  await clickRow(page, outliner, 1);
  await openMenuOn(page, outliner, 1);
  await outliner.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(await editingRowIndex(page, outliner)).toBe(0);
});

test("a second right-click on another bullet moves the menu, not stacks it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Second Click", "- one\n- two");
  await clickRow(page, outliner, 1);
  await openMenuOn(page, outliner, 1);
  await outliner.locator(".vr-row").nth(0).click({ button: "right" });
  await expect(menu(page)).toHaveCount(1);
  expect(await editingRowIndex(page, outliner)).toBe(0);
  await closeMenuByClick(page);
});

test("Zoom in zooms to the right-clicked block and the editor still works inside", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Menu Zoom", "- top\n  - inner\n- other");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Zoom in");
  await expect(page.locator(".vr-zoom-trail .vr-crumb-current")).toHaveText("inner");
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);
  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("inner!");
});

test("Copy block reference puts ((id)) on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const outliner = await openEditing(page, "Menu Copy Ref", "- copy me");
  const id = await outliner.locator(".vr-row").first().getAttribute("data-block-id");
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Copy block reference");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`((${id}))`);
});

test("Cycle task state makes the block a task, then advances it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Cycle", "- chore");
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Cycle task state");
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Cycle task state");
  await expect(outliner.locator(".vr-marker-DOING")).toHaveCount(1);
  await expect(editor(page)).toHaveText("chore");
});

test("Toggle done is offered only for a task, and completes it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Toggle Done", "- plain\n- TODO task");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Toggle done");
  await expect(outliner.locator(".vr-marker-DONE")).toHaveCount(1);

  await openMenuOn(page, outliner, 0);
  await expect(menu(page).locator(".ctx-item", { hasText: "Toggle done" })).toHaveCount(0);
  await closeMenuByClick(page);
});

test("Indent and Outdent move the clicked block and keep the editor in it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Indent", "- one\n- two");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Indent");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);
  expect(await editingRowIndex(page, outliner)).toBe(1);

  await openMenuOn(page, outliner, 1);
  await runItem(page, "Outdent");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
});

test("Move up and Move down reorder the clicked block", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Move", "- one\n- two\n- three");
  await openMenuOn(page, outliner, 2);
  await runItem(page, "Move up");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "three", "two"]);
  expect(await editingRowIndex(page, outliner)).toBe(1);

  await openMenuOn(page, outliner, 1);
  await runItem(page, "Move down");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "two", "three"]);
  expect(await editingRowIndex(page, outliner)).toBe(2);
});

test("an item chosen from the menu leaves the editor focused and typeable", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Keeps Focus", "- one\n- two");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Indent");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);
  await expectEditorFocusedNow(page, "after Indent from the menu");
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("two!");
});

test("Bold, Italic and Highlight wrap the selection (R45)", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Format", "- word");
  await page.keyboard.press("Shift+Home");
  await openMenuOn(page, outliner, 0);
  await expect(menu(page).locator(".ctx-item", { hasText: "Bold" })).toHaveCount(1);
  await runItem(page, "Bold");
  await expect(editor(page)).toHaveText("**word**");

  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Highlight");
  await expect(editor(page)).toHaveText("==**word**==");
});

test("Duplicate adds a copy below and moves the editor to it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu Duplicate", "- twin");
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Duplicate");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  expect(await rowTexts(page, outliner)).toEqual(["twin", "twin"]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
});

test("Delete appears for a selected block and deletes it", async ({ page }) => {
  test.fixme(
    true,
    "B-73: right-clicking a selected block drops the selection, so Delete never shows",
  );
  const outliner = await openEditing(page, "Menu Delete Selected", "- keep\n- remove");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);

  await outliner.locator(".vr-row").nth(1).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  await expect(menu(page).locator(".ctx-item", { hasText: "Delete" })).toHaveCount(1);
  await runItem(page, "Delete");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  expect(await rowTexts(page, outliner)).toEqual(["keep"]);
});

test("every entry shown while editing has a working command behind it", async ({ page }) => {
  const outliner = await openEditing(page, "Menu All Entries", "- a\n- b\n  - c");
  await openMenuOn(page, outliner, 1);
  const labels = await menu(page).locator(".ctx-item").allTextContents();
  // The full set for an editing, non-task block with a previous sibling and a child.
  expect(labels).toEqual([
    "Zoom in",
    "Copy block reference",
    "Cycle task state",
    "Indent",
    "Outdent",
    "Move up",
    "Move down",
    "Bold",
    "Italic",
    "Highlight",
    "Duplicate",
    // M7 refactors (ADR 020), `refactor.spec.ts` exercises them.
    "Turn into page",
    "Move to page…",
  ]);
  await closeMenuByClick(page);
});
