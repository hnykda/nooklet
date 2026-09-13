/**
 * The autocomplete opened by walking the caret INTO an existing `[[link]]` (B-203's precondition).
 * Picking a row replaced only the text between the trigger and the caret, so the rest of the old
 * link stayed behind the new one: `alpha [[Target]]arget]] omega` (B-294). A pick now replaces the
 * whole link it sits in. (`#tag` is not covered — B-380.) Page names start with "Walk Link" or
 * "Inside Link Source" — no other spec uses them.
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
  await seedPage(page, "Walk Link Target", "- here");
  const name = "Inside Link Source Walk";
  await openEditing(page, name, "- alpha [[Walk Link Target]] omega");
  await walkTo(page, "alpha [[Walk Link Ta".length);
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walk Link Target");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  // The caret lands after the link's `]]`, not inside what was its tail.
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walk Link Target]]! omega"]);
});

test("typing inside an existing link and picking another page replaces the whole link (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walk Link Target", "- here");
  await seedPage(page, "Walk Link Other", "- there");
  const name = "Inside Link Source Retarget";
  await openEditing(page, name, "- alpha [[Walk Link Target]] omega");
  await walkTo(page, "alpha [[Walk Link ".length);
  await page.keyboard.type("Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walk Link Other");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect.poll(() => stored(page, name)).toEqual(["alpha [[Walk Link Other]] omega"]);
});

test("a new [[ typed right before an existing link leaves that link alone (B-294)", async ({
  page,
}) => {
  await seedPage(page, "Walk Link Target", "- here");
  await seedPage(page, "Walk Link Other", "- there");
  const name = "Inside Link Source Before";
  await openEditing(page, name, "- see [[Walk Link Target]]");
  await walkTo(page, "see ".length);
  await page.keyboard.type("[[Walk Link Oth");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toContainText("Walk Link Other");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect
    .poll(() => stored(page, name))
    .toEqual(["see [[Walk Link Other]][[Walk Link Target]]"]);
});
