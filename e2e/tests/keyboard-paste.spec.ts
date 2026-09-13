/**
 * Cmd/Ctrl+V into a block, with the real key (B-536).
 *
 * The editor pastes from the browser's `paste` event (`editor/surface.ts`), which only exists if
 * nothing cancels the keydown that produces it. The command dispatcher matched `edit.paste`'s
 * informational Cmd+V row and `preventDefault()`ed it, so a paste into a block inserted nothing —
 * while every other paste test here built a synthetic `ClipboardEvent` and passed. These press the
 * key and let the browser do the rest.
 *
 * Page names start with "KP " so they cannot collide with another spec's on the shared server.
 */
import { expect, test } from "@playwright/test";
import { MOD, openEditing, readBlocks } from "../helpers/index.js";

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("Cmd/Ctrl+V pastes plain text at the caret (B-536)", async ({ page }) => {
  const name = "KP Plain Text";
  const outliner = await openEditing(page, name, "- hello");
  await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
  await page.keyboard.press(`${MOD}+V`);

  await expect(outliner.locator(".vr-row").first()).toContainText("hello pasted");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["hello pasted"]);
});

test("Cmd/Ctrl+V with several lines pastes them as blocks (B-536, R33 case 2)", async ({
  page,
}) => {
  const name = "KP Lines";
  await openEditing(page, name, "- first");
  await page.evaluate(() => navigator.clipboard.writeText("- second\n- third"));
  await page.keyboard.press(`${MOD}+V`);

  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["first", "second", "third"]);
});
