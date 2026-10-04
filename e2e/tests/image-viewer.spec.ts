/**
 * B-736: a click on an image in a note opens it in a viewer (Copy image / Download / Open in new
 * tab) instead of entering the editor, which swapped the picture for its `![…](assets/…)` source.
 * A click on the block's text still edits. Download must produce the image's actual bytes.
 */
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { api, editingRowIndex, openPage, runName } from "../helpers/index.js";
import { solidPng } from "../helpers/png.js";

async function upload(page: Page, name: string) {
  const bytes = solidPng(64, 48, [200, 120, 40]);
  const up = await api<{ markdown: string }>(page, "asset.upload", {
    filename: `${name}.png`,
    mime_type: "image/png",
    data_base64: bytes.toString("base64"),
  });
  return { ...up, bytes };
}

test("B-736: clicking an image opens the viewer, not the editor; Download saves it", async ({
  page,
}, info) => {
  const name = runName("Image Viewer", info);
  const { markdown, bytes } = await upload(page, name.replaceAll(" ", "-"));
  // Alt text set, so the saved name is predictable.
  const md = markdown.replace(/^!\[[^\]]*\]/, "![garden shed]");
  const outliner = await openPage(page, name, `- look at this ${md}\n- next block`);
  const img = outliner.locator("img.vr-image").first();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(64);

  await img.click();
  const dialog = page.getByRole("dialog", { name: "Image: garden shed" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img.image-viewer-img")).toHaveJSProperty("naturalWidth", 64);
  // The block stayed rendered: no editor anywhere, the picture still in the row.
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await expect(page.locator(".cm-content")).toHaveCount(0);
  await expect(img).toBeVisible();

  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("garden shed.png");
  const saved = await download.path();
  expect(Buffer.compare(await readFile(saved), bytes)).toBe(0);
  await expect(dialog.getByRole("status")).toContainText(
    "Downloaded garden shed.png to your browser's downloads folder.",
  );
  expect(await editingRowIndex(page, outliner)).toBe(-1);

  // Escape closes it — and only it: the block does not enter editing or selection.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await expect(page.locator(".vr-row-selected")).toHaveCount(0);

  // Open again, close on the backdrop.
  await img.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  expect(await editingRowIndex(page, outliner)).toBe(-1);

  // From the keyboard: Enter on the focused picture opens it (with the app's global keymap live),
  // and closing hands focus back to the picture.
  await img.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(img).toBeFocused();
  expect(await editingRowIndex(page, outliner)).toBe(-1);

  // The text beside the picture still edits, as before.
  await outliner.locator(".vr-row").first().getByText("look at this").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await editingRowIndex(page, outliner)).toBe(0);
});

test("B-736: Copy image puts a PNG on the clipboard", async ({
  page,
  context,
  browserName,
}, info) => {
  // Playwright cannot grant WebKit clipboard permissions, so there is no reading it back.
  test.skip(browserName !== "chromium", "clipboard read-back needs Chromium's permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = runName("Image Viewer copy", info);
  const { markdown } = await upload(page, name.replaceAll(" ", "-"));
  const outliner = await openPage(page, name, `- ${markdown}`);
  await outliner.locator("img.vr-image").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Copy image" }).click();
  await expect(dialog.getByRole("status")).toContainText("Image copied to the clipboard.");
  const types = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return items.flatMap((i) => [...i.types]);
  });
  expect(types).toContain("image/png");

  // B-744: copying does not use up the viewer: Download still works right after, and says where.
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  await download;
  await expect(dialog.getByRole("status")).toContainText("to your browser's downloads folder.");
});
