/**
 * Alt+Enter ("Follow link under cursor") while the autocomplete popup is open (B-203).
 *
 * Walking the caret into an existing `[[link]]` or `#tag` re-detects the trigger before the caret
 * and opens the autocomplete, which claims Enter. The keymap then yielded EVERY Enter to the popup
 * — Alt+Enter included — while the editor, which is what feeds that popup its keys, only ever
 * offers it keys without Cmd/Ctrl/Alt. So Alt+Enter went to nobody. It was not Playwright's Alt
 * handling on macOS: a raw CDP key event did the same (`tools/probes/alt-enter-follow-link.spec.ts`).
 * Page names start with "Follow Popup" — no other spec uses them.
 */

import { expect, test } from "@playwright/test";
import { openEditing, readBlocks, seedPage } from "../helpers/index.js";

test("Alt+Enter follows a [[link]] the caret was walked into, though that opened the autocomplete", async ({
  page,
}) => {
  await seedPage(page, "Follow Popup Target", "- here");
  const name = "Follow Popup Walk";
  await openEditing(page, name, "- alpha [[Follow Popup Target]] omega");
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  // The precondition that broke it: the popup is up over a caret inside a complete link.
  await expect(page.locator(".cmd-popup")).toBeVisible();
  await page.keyboard.press("Alt+Enter");
  await expect(page).toHaveURL(/\/page\/follow%20popup%20target$/i);
  expect((await readBlocks(page, name))[0]?.content).toBe("alpha [[Follow Popup Target]] omega");
});

test("with the autocomplete open, plain Enter is still the popup's: it picks a row, it does not split the block", async ({
  page,
}) => {
  await seedPage(page, "Follow Popup Picked", "- here");
  const name = "Follow Popup Plain Enter";
  await openEditing(page, name, "- see");
  await page.keyboard.type(" [[Follow Popup Pick");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Follow Popup Picked");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["see [[Follow Popup Picked]]"]);
});
