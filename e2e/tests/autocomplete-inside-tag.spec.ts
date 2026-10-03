/**
 * The `#tag` form of B-294 (B-380). Walking the caret into an existing `#tag` re-detected the `#`
 * before it and opened the tag autocomplete; Enter picked a row and replaced only the part before
 * the caret, leaving the tag's tail behind: `alpha #WalkTagTarget!agTarget omega`. A tag has no
 * closer, so the owner chose not to open the popup when the text after the caret continues the tag
 * (option c) — Enter there is then a plain Enter. Typing a fresh tag, and the `#[[multi word]]`
 * form, must still get the popup. Each test has its own target page: test one leaves a `#Tagw`
 * tag page behind, which a fresh `#Tagw` query would rank first. Page names start with "Tagwalk" so they collide with nothing on
 * the shared server.
 */

import { expect, type Page, test } from "@playwright/test";
import { openEditing, readBlocks, seedPage } from "../helpers/index.js";

async function walkTo(page: Page, offset: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let i = 0; i < offset; i++) await page.keyboard.press("ArrowRight");
}

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("walking into an existing #tag opens no popup, and Enter does not duplicate its tail (B-380)", async ({
  page,
}) => {
  await seedPage(page, "TagwalkTarget", "- here");
  const name = "Tagwalk Src One";
  await openEditing(page, name, "- alpha #TagwalkTarget omega");
  // Walk past the `#` first: the popup may open there and must close once the caret is inside.
  await walkTo(page, "alpha #Tagw".length);
  // Every keyup re-detects synchronously; a short wait lets a late render show up if it were coming.
  await page.waitForTimeout(300);
  await expect(page.locator(".cmd-popup")).toHaveCount(0);
  // With no popup, Enter splits the block at the caret, as anywhere else in plain text.
  await page.keyboard.press("Enter");
  await expect.poll(() => stored(page, name)).toEqual(["alpha #Tagw", "alkTarget omega"]);
});

test("the caret at the end of an existing #tag still opens the popup, and a pick keeps one tag (B-380)", async ({
  page,
}) => {
  await seedPage(page, "TagwalkTarget", "- here");
  const name = "Tagwalk Src Two";
  await openEditing(page, name, "- alpha #TagwalkTarget omega");
  await walkTo(page, "alpha #TagwalkTarget".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("TagwalkTarget");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha #TagwalkTarget omega"]);
});

test("typing a fresh #tag still opens the popup and Enter inserts the tag (B-380 guard)", async ({
  page,
}) => {
  await seedPage(page, "TagwalkFresh", "- here");
  const name = "Tagwalk Src Three";
  await openEditing(page, name, "- alpha omega");
  await page.keyboard.press("End");
  await page.keyboard.type(" #TagwalkFr");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("TagwalkFresh");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha omega #TagwalkFresh"]);
});

test("typing #[[ still opens the multi-word form and a pick inserts #[[Title]] (B-380 guard)", async ({
  page,
}) => {
  await seedPage(page, "Tagwalk Multi Word", "- here");
  const name = "Tagwalk Src Four";
  await openEditing(page, name, "- alpha");
  await page.keyboard.press("End");
  await page.keyboard.type(" #[[Tagwalk Mul");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Tagwalk Multi Word");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha #[[Tagwalk Multi Word]]"]);
});
