/**
 * Probe (2026-09-13, m10/editor-keys): the `#tag` form of B-294, left open as B-380. Prints what
 * the block holds after Enter on the tag autocomplete that walking the caret into `#WalkTagTarget`
 * opened, and after the same pick where `#` was typed straight before an existing word. The first
 * duplicates the tag's tail (`#WalkTagTarget!agTarget`); swallowing the tail to fix it would delete
 * `omega` in the second, and nothing tells the two apart — see B-380.
 *
 * To re-run: copy into `e2e/tests/`, then
 *   NOOKLET_DATA=<scratch>/data NOOKLET_E2E_PORT=<port> pnpm --dir e2e exec playwright test \
 *     tests/autocomplete-tag-walk.spec.ts --project=chromium --reporter=list
 * and delete the copy.
 */
import { expect, type Page, test } from "@playwright/test";
import { openEditing, readBlocks, seedPage } from "../helpers/index.js";

async function walkTo(page: Page, offset: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let i = 0; i < offset; i++) await page.keyboard.press("ArrowRight");
}

test("B-380: walk into a #tag, Enter on the popup", async ({ page }) => {
  await seedPage(page, "WalkTagTarget", "- here");
  const name = "Probe Tag Walk From";
  await openEditing(page, name, "- alpha #WalkTagTarget omega");
  await walkTo(page, "alpha #WalkT".length);
  await expect(page.locator(".cmd-popup .cmd-row--active")).toContainText("WalkTagTarget");
  await page.keyboard.press("Enter");
  await page.keyboard.type("!");
  await page.waitForTimeout(1200);
  console.log("B-380 walked in:", JSON.stringify((await readBlocks(page, name))[0]?.content));
});

test("B-380: # typed straight before a word, then a pick", async ({ page }) => {
  await seedPage(page, "WalkTagTarget", "- here");
  const name = "Probe Tag Typed Before";
  await openEditing(page, name, "- alpha omega");
  await walkTo(page, "alpha ".length);
  await page.keyboard.type("#WalkT");
  await expect(page.locator(".cmd-popup .cmd-row--active")).toContainText("WalkTagTarget");
  await page.keyboard.press("Enter");
  await page.keyboard.type("!");
  await page.waitForTimeout(1200);
  console.log("B-380 typed before:", JSON.stringify((await readBlocks(page, name))[0]?.content));
});
