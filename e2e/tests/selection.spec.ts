/**
 * Block-selection mode (docs/spec/commands-and-keymap.md R28–R31): Escape selects, Shift+Up/Down
 * extends, Backspace deletes, Tab/Shift+Tab indent the selection, Cmd/Ctrl+A selects all,
 * Cmd/Ctrl+C copies markdown, Enter edits, and a click clears. Two ways in — Escape from the
 * editor, and Cmd/Ctrl+click on a rendered row — both have to leave the keyboard working.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  clickRow,
  editingRowIndex,
  editor,
  MOD,
  openEditing,
  rowDepths,
  rowTexts,
} from "../helpers/index.js";

function selected(outliner: Locator): Locator {
  return outliner.locator(".vr-row-selected");
}

async function selectedTexts(page: Page, outliner: Locator): Promise<string[]> {
  const texts = await rowTexts(page, outliner);
  const flags = await outliner
    .locator(".vr-row")
    .evaluateAll((rows) => rows.map((r) => r.classList.contains("vr-row-selected")));
  return texts.filter((_, i) => flags[i]);
}

test("Escape selects exactly the block being edited", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Escape", "- one\n- two");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveCount(0);
  expect(await selectedTexts(page, outliner)).toEqual(["two"]);
});

test("Escape again clears the selection (R28)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Escape Clear", "- one");
  await page.keyboard.press("Escape");
  await expect(selected(outliner)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(selected(outliner)).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
});

test("Shift+Down from the editor starts a two-block selection (R30)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Shift Down", "- one\n- two\n- three");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(editor(page)).toHaveCount(0);
  expect(await selectedTexts(page, outliner)).toEqual(["one", "two"]);
});

test("Shift+Down keeps extending and Shift+Up shrinks it back (R30)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Shift Extend", "- one\n- two\n- three");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selectedTexts(page, outliner)).toEqual(["one", "two", "three"]);
  await page.keyboard.press("Shift+ArrowUp");
  expect(await selectedTexts(page, outliner)).toEqual(["one", "two"]);
});

test("Escape then Shift+Down extends the selection from the keyboard", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Escape Extend", "- one\n- two\n- three");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Escape");
  await expect(selected(outliner)).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(outliner)).toHaveCount(2);
  expect(await selectedTexts(page, outliner)).toEqual(["one", "two"]);
});

test("Enter on a selection edits the block the selection was last extended to (R29)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Sel Enter Focus", "- one\n- two");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(1);
  await expect(editor(page)).toBeFocused();
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await expect(selected(outliner)).toHaveCount(0);
});

test("Backspace deletes every selected block and its subtree (R31)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Delete", "- keep\n- gone\n  - gone child\n- also");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Shift+ArrowDown"); // "gone" + "gone child"
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["keep", "also"]);
  await expect(selected(outliner)).toHaveCount(0);
});

test("Delete also deletes the selection (secondary default binding, R21)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Delete Key", "- keep\n- gone");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["keep"]);
});

test("Tab indents the whole selection and Shift+Tab outdents it (R31)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Indent", "- one\n- two\n- three");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selectedTexts(page, outliner)).toEqual(["two", "three"]);

  await page.keyboard.press("Tab");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1, 1]);
  // Still selected afterwards, so the next key acts on the same blocks.
  expect(await selectedTexts(page, outliner)).toEqual(["two", "three"]);

  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0, 0]);
});

test("Cmd/Ctrl+A selects every visible block (R31)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel All", "- one\n- two\n- three");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+a`);
  await expect(selected(outliner)).toHaveCount(3);
});

test("Cmd/Ctrl+C copies the selection as markdown (R31)", async ({ page, context }) => {
  test.fixme(true, "B-84: block.copySelection has no implementation");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const outliner = await openEditing(page, "Sel Copy", "- parent\n  - child\n- other");
  await clickRow(page, outliner, 0);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+c`);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^- parent\n\s+- child\s*$/);
});

test("Alt+Down moves the selected block and keeps it selected (R22)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Move", "- one\n- two");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["two", "one"]);
  expect(await selectedTexts(page, outliner)).toEqual(["one"]);
});

test("Cmd/Ctrl+Enter cycles a single selected block's task state (R34)", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Task Cycle", "- chore");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(outliner.locator(".vr-marker-TODO")).toHaveCount(1);
  await expect(selected(outliner)).toHaveCount(1);
});

test("clicking a block clears the selection and starts editing it", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Click Clears", "- one\n- two\n- three");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(outliner)).toHaveCount(2);
  await clickRow(page, outliner, 2);
  await expect(selected(outliner)).toHaveCount(0);
  expect(await editingRowIndex(page, outliner)).toBe(2);
});

test("Cmd/Ctrl+click selects a row, and a second Cmd/Ctrl+click extends the range", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Sel Mod Click", "- one\n- two\n- three");
  await outliner
    .locator(".vr-row")
    .nth(1)
    .locator(".vr-block-view")
    .click({ modifiers: [MOD] });
  expect(await selectedTexts(page, outliner)).toEqual(["two"]);
  await expect(editor(page)).toHaveCount(0);
  await outliner
    .locator(".vr-row")
    .nth(2)
    .locator(".vr-block-view")
    .click({ modifiers: [MOD] });
  expect(await selectedTexts(page, outliner)).toEqual(["two", "three"]);
});

test("the keyboard works from a click-made selection too", async ({ page }) => {
  const outliner = await openEditing(page, "Sel Mod Click Keys", "- one\n- two");
  await outliner
    .locator(".vr-row")
    .nth(1)
    .locator(".vr-block-view")
    .click({ modifiers: [MOD] });
  await expect(selected(outliner)).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one"]);
});

test("right-clicking a selected block keeps the selection", async ({ page }) => {
  test.fixme(true, "B-73: right-clicking a selected block drops the selection");
  const outliner = await openEditing(page, "Sel Right Click", "- one\n- two");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Escape");
  await expect(selected(outliner)).toHaveCount(1);
  await outliner.locator(".vr-row").nth(1).click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(selected(outliner)).toHaveCount(1);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await expect(selected(outliner)).toHaveCount(1);
});

test("typing a printable key in selection mode does not edit or delete anything", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Sel Printable", "- untouched");
  await page.keyboard.press("Escape");
  await page.keyboard.type("xyz");
  await expect(editor(page)).toHaveCount(0);
  expect(await rowTexts(page, outliner)).toEqual(["untouched"]);
});
