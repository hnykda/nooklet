/**
 * Getting an image into a block from the editor: `/image` (B-99) and pasting one (B-150).
 *
 * Both go through `asset.upload` from the served client — the one place the client's own API
 * credential is on the line. `assets.spec.ts` covers rendering an uploaded image, but it uploads
 * through the test's own authenticated helper, which is exactly why a client that sent no token at
 * all could pass it. What is stored is read back through `page.read`; the live preview hides
 * markup while editing.
 */

import { expect, type Page, test } from "@playwright/test";
import { clickAway, openEditing, readBlocks } from "../helpers/index.js";

// A 1x1 transparent PNG (67 bytes) — the same fixture `assets.spec.ts` uses.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_MD = /!\[[^\]]*\]\(assets\/[a-z0-9]+\.png\)/;

async function expectRenderedImage(page: Page): Promise<void> {
  const img = page.locator(".vr-outliner img.vr-image").first();
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

test("/image opens a file chooser and inserts the uploaded image at the caret (B-99)", async ({
  page,
}) => {
  await openEditing(page, "Image Slash", "- look");
  await page.keyboard.type(" /image");
  await expect(page.locator(".cmd-popup .cmd-row--active")).toHaveText("Image");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(false);
  await fileChooser.setFiles({
    name: "dot.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1X1, "base64"),
  });

  await expect
    .poll(async () => (await readBlocks(page, "Image Slash"))[0]?.content ?? "")
    .toMatch(new RegExp(`^look ${IMAGE_MD.source}$`));
  // Typing goes on after the image, not in front of it (B-343: the caret stayed before it).
  await page.keyboard.type(" Z");
  await expect
    .poll(async () => (await readBlocks(page, "Image Slash"))[0]?.content ?? "")
    .toMatch(new RegExp(`^look ${IMAGE_MD.source} Z$`));
  // The chooser's input is gone again: nothing left behind in the document per use.
  await expect(page.locator("input[data-nooklet-image-picker]")).toHaveCount(0);
  await clickAway(page);
  await expectRenderedImage(page);
});

test("pasting an image uploads it with the client's credential and inserts it (B-150)", async ({
  page,
}) => {
  await openEditing(page, "Image Paste", "- pasted");
  await page.keyboard.type(" ");
  await page.locator(".cm-content").evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PNG_1X1);

  await expect
    .poll(async () => (await readBlocks(page, "Image Paste"))[0]?.content ?? "")
    .toMatch(new RegExp(`^pasted ${IMAGE_MD.source}$`));
  await page.keyboard.type(" Z");
  await expect
    .poll(async () => (await readBlocks(page, "Image Paste"))[0]?.content ?? "")
    .toMatch(new RegExp(`^pasted ${IMAGE_MD.source} Z$`));
  await clickAway(page);
  await expectRenderedImage(page);
});
