/**
 * B-640: a block typed with Enter rendered as an empty row with no bullet once the editor left
 * it, until it was clicked into again — in the Mac app and on the iPhone (both WebKit). The text
 * was in the DOM all along; WebKit never painted it.
 *
 * Cause (`tools/probes/b640/webkit-cv-focus.mjs` reproduces it with plain DOM calls, no app):
 * every row is `content-visibility: auto` (the long-page strategy, `editor.css`), and WebKit
 * leaves such an element SKIPPED for good when it is inserted with focus moving into it — which
 * is exactly Enter: a new row is inserted and the single editor is moved into it in the same task.
 * When the editor moves on, the row's content stays skipped although it is on screen. Chromium
 * paints it, so the WebKit project is the one that goes red; both run it.
 *
 * Asserted with `checkVisibility({ contentVisibilityAuto: true })`, which is false for content a
 * skipped `content-visibility: auto` ancestor is not rendering — the probe confirms by screenshot
 * that those rows are blank. Text assertions cannot see this bug.
 *
 * Page names start with "RPE " so they cannot collide with another spec's on the shared server.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { editor, openPage, runName } from "../helpers/index.js";

function unique(base: string): string {
  const info = test.info();
  return `${runName(base, info)} ${info.project.name}`;
}

/** Each row's read-only text and whether the engine renders it (and its bullet). */
async function rendered(outliner: Locator): Promise<string[]> {
  return outliner.locator(".vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const view = r.querySelector(".vr-block-view");
      const bullet = r.querySelector(".vr-bullet");
      if (!view) return "<editing>";
      const shown =
        view.checkVisibility({ contentVisibilityAuto: true }) &&
        bullet?.checkVisibility({ contentVisibilityAuto: true });
      return `${shown ? "shown" : "NOT RENDERED"}: ${view.textContent}`;
    }),
  );
}

async function startEditing(page: Page, outliner: Locator, text: string): Promise<void> {
  await outliner.locator(".vr-block-view", { hasText: text }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
}

test("rows typed with Enter are rendered once the editor leaves them (B-640)", async ({ page }) => {
  const outliner = await openPage(page, unique("RPE chain"), "- first");
  await startEditing(page, outliner, "first");
  for (const line of ["second", "third"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
  await page.keyboard.press("Enter");
  await expect
    .poll(() => rendered(outliner))
    .toEqual(["shown: first", "shown: second", "shown: third", "<editing>"]);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => rendered(outliner))
    .toEqual(["shown: first", "shown: second", "shown: third", "shown: "]);
});

test("the owner's sequence: Enter, Shift+Tab, type, Enter leaves a parent row rendered (B-640)", async ({
  page,
}) => {
  const outliner = await openPage(page, unique("RPE outdent"), "- Three\n  - Nested");
  await startEditing(page, outliner, "Nested");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("Ok these ones");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Nothing");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => rendered(outliner))
    .toEqual(["shown: Three", "shown: Nested", "shown: Ok these ones", "shown: Nothing"]);
});
