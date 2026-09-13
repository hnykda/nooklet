/**
 * Typing in a text field other than the block editor while blocks are selected (B-347). The command
 * dispatcher sees every keydown first; with a standing block selection, Backspace or Delete typed
 * into the command palette deleted the selected blocks — on the server too — and never reached the
 * input, and Cmd/Ctrl+A selected every block instead of the query. What is stored is read back
 * through `page.read`.
 */

import { expect, test } from "@playwright/test";
import { MOD, openEditing, readBlocks } from "../helpers/index.js";

test("Backspace, Delete and Select All in the palette edit the query, not the selected blocks (B-347)", async ({
  page,
}) => {
  const name = "Palette Keys Selection";
  const outliner = await openEditing(page, name, "- keys one\n- keys two\n- keys three");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  const selected = outliner.locator(".vr-row-selected");
  await expect(selected).toHaveCount(2);

  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  const input = palette.locator(".cmd-input");
  await expect(palette).toBeVisible();
  await page.keyboard.type("abcd");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("abc");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await expect(input).toHaveValue("ab");

  await page.keyboard.press(`${MOD}+a`);
  expect(
    await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 2]);
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("");

  // The selection and the blocks are untouched, locally and on the server.
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await expect(selected).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".app-sync-indicator")).toHaveText("synced");
  expect((await readBlocks(page, name)).map((b) => b.content)).toEqual([
    "keys one",
    "keys two",
    "keys three",
  ]);

  // With the palette closed, Backspace on the selection still deletes it: the lock is on the
  // text field, not on the command.
  await expect(selected).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
});
