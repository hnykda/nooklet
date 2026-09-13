/**
 * The autocomplete opened by walking the caret INTO an existing `[[link]]` (B-203's precondition).
 * Picking a row replaced only the text between the trigger and the caret, so the rest of the old
 * link stayed behind the new one: `alpha [[Target]]arget]] omega` (B-294). A pick now replaces the
 * whole link it sits in. (`#tag` is not covered — B-380.) Page names start with "Walkin" or "Caret
 * Inside Src" — never "Link Target", which `link-unlinked.spec.ts` counts as
 * a mention on the shared server.
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

test("Enter on the autocomplete a walk into a complete [[link]] opened keeps one link (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  const name = "Caret Inside Src One";
  await openEditing(page, name, "- alpha [[Walkin Goal Page]] omega");
  await walkTo(page, "alpha [[Walkin Go".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Goal Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  // The caret lands after the link's `]]`, not inside what was its tail.
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walkin Goal Page]]! omega"]);
});

test("typing inside an existing link and picking another page replaces the whole link (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  await seedPage(page, "Walkin Other Page", "- there");
  const name = "Caret Inside Src Two";
  await openEditing(page, name, "- alpha [[Walkin Goal Page]] omega");
  await walkTo(page, "alpha [[Walkin ".length);
  await page.keyboard.type("Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Other Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walkin Other Page]] omega"]);
});

test("a new [[ typed right before an existing link leaves that link alone (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walkin Goal Page", "- here");
  await seedPage(page, "Walkin Other Page", "- there");
  const name = "Caret Inside Src Three";
  await openEditing(page, name, "- see [[Walkin Goal Page]]");
  await walkTo(page, "see ".length);
  await page.keyboard.type("[[Walkin Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walkin Other Page");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect
    .poll(() => stored(page, name))
    .toEqual(["see [[Walkin Other Page]][[Walkin Goal Page]]"]);
});
