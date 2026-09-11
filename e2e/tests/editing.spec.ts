/**
 * The bugs this file exists for, all reported from real use against a served production build:
 *
 *  - typing exactly one character ended editing (a `<For>` keyed on rebuilt row objects recreated
 *    every row's DOM on each keystroke, tearing out the element the single CM6 surface lives in);
 *  - text typed before clicking away did not appear afterwards, only after a reload;
 *  - the served client had no API credential, so sync sat flapping "offline".
 */

import { expect, type Page, test } from "@playwright/test";

/**
 * Opens the journal and guarantees a real, CodeMirror-backed outliner to type into.
 *
 * Today starts *virtual* (PLAN.md §8: "today is virtual until it has a block"), rendered by
 * `VirtualJournalDay` as a plain `<textarea>`. Committing it creates the page and its first block
 * and swaps in the real `BlockTree`. That two-stage handover is itself part of what made the
 * original bug confusing: the first bullet typed fine because it was a textarea, and editing only
 * died once CodeMirror took over.
 */
async function openJournal(page: Page): Promise<void> {
  await page.goto("/journals");
  const virtualDraft = page.locator(".block-content-input").first();
  const outliner = page.locator(".vr-outliner").first();

  await expect(virtualDraft.or(outliner)).toBeVisible();
  if (await virtualDraft.isVisible()) {
    await virtualDraft.fill("seed");
    await virtualDraft.blur();
  }
  await expect(outliner).toBeVisible();
}

/** The editable surface for the row currently being edited. */
function editor(page: Page) {
  return page.locator(".cm-content");
}

test("types a whole sentence into a bullet without editing dying", async ({ page }) => {
  await openJournal(page);

  const first = page.locator(".vr-outliner").first().locator(".vr-block-view").first();
  await first.click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");

  // The regression: this used to stop after the first character.
  const sentence = "the quick brown fox";
  await page.keyboard.type(sentence, { delay: 20 });

  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText(sentence);
});

test("text survives blurring the block, without a reload", async ({ page }) => {
  await openJournal(page);

  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" persisted text", { delay: 20 });

  // Click away — the surface detaches and the row must render what was typed.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(outliner).toContainText("persisted text");

  // And it must still be there after a full reload, i.e. it really reached the database.
  await page.reload();
  await expect(page.locator(".vr-outliner").first()).toContainText("persisted text");
});

test("Enter creates a second bullet and both keep their text", async ({ page }) => {
  await openJournal(page);

  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" first bullet", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("second bullet", { delay: 20 });

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(outliner).toContainText("first bullet");
  await expect(outliner).toContainText("second bullet");

  await page.reload();
  const reloaded = page.locator(".vr-outliner").first();
  await expect(reloaded).toContainText("first bullet");
  await expect(reloaded).toContainText("second bullet");
});
