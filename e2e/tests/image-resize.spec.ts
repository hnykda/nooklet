/**
 * B-789: Logseq's image handling. A handle on the picture's edge resizes it, the size is written to
 * the block as Logseq's `{:width N}` map in ONE edit when the drag ends (ADR 034), it survives a
 * reload, and undo puts the old size back. The ⋯ menu downloads the picture and aligns it. A size
 * written by Logseq (`{:height 236, :width 500}`) renders as a size.
 *
 * Also run in WebKit (the Mac app's engine).
 */
import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, editingRowIndex, MOD, openPage, readBlocks, runName } from "../helpers/index.js";
import { solidPng } from "../helpers/png.js";

async function upload(page: Page, name: string, width: number, height: number) {
  const bytes = solidPng(width, height, [30, (width * 3) % 256, (height * 5) % 256]);
  const up = await api<{ markdown: string }>(page, "asset.upload", {
    filename: `${name}.png`,
    mime_type: "image/png",
    data_base64: bytes.toString("base64"),
  });
  return { ...up, bytes };
}

async function loaded(img: Locator, width: number): Promise<void> {
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(width);
}

async function widthOf(loc: Locator): Promise<number> {
  const box = await loc.boundingBox();
  if (!box) throw new Error("not on screen");
  return box.width;
}

/** Drags the handle by `dx` pixels, in steps, like a hand would. */
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("no handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y);
  await page.mouse.up();
}

test("B-789: dragging the handle writes one size, kept after a reload; undo restores the old one", async ({
  page,
}, info) => {
  const name = runName(`Image Resize ${info.project.name}`, info);
  const { markdown } = await upload(page, name.replaceAll(" ", "-"), 400, 300);
  const outliner = await openPage(page, name, `- ${markdown}\n- below the picture`);
  const img = outliner.locator("img.vr-image").first();
  await loaded(img, 400);
  const box = outliner.locator(".vr-image-box").first();
  expect(await widthOf(img)).toBeCloseTo(400, 0);

  await box.hover();
  const handle = box.locator(".vr-image-handle");
  await expect(handle).toBeVisible();
  await drag(page, handle, -150);

  // In the block's text, in Logseq's syntax (one edit: one undo below takes all of it back).
  await expect
    .poll(async () => (await readBlocks(page, name))[0]?.content)
    .toMatch(/\{:width (24[5-9]|25[0-5])\}$/);
  const content = (await readBlocks(page, name))[0]?.content ?? "";
  expect(content.startsWith(markdown)).toBe(true);
  const written = Number(/:width (\d+)/.exec(content)?.[1]);
  expect(await widthOf(img)).toBeCloseTo(written, 0);
  // Aspect ratio kept.
  expect(await widthOf(img)).toBeCloseTo(((await img.boundingBox())?.height ?? 0) * (4 / 3), 0);
  // The drag neither entered the editor nor opened the viewer.
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Undo puts the picture's own size back, in the text and on screen; redo the new one.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await readBlocks(page, name))[0]?.content).toBe(markdown);
  await expect.poll(() => widthOf(img)).toBeCloseTo(400, 0);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(async () => (await readBlocks(page, name))[0]?.content).toBe(content);

  // After a reload: same text, same size.
  await page.reload();
  const again = page.locator(".vr-outliner").first().locator("img.vr-image").first();
  await loaded(again, 400);
  expect(await widthOf(again)).toBeCloseTo(written, 0);
  expect((await readBlocks(page, name))[0]?.content).toBe(content);
});

test("B-789: a drag past the column stops at the column; the source is never wider", async ({
  page,
}, info) => {
  const name = runName(`Image Resize wide ${info.project.name}`, info);
  const { markdown } = await upload(page, name.replaceAll(" ", "-"), 300, 100);
  const outliner = await openPage(page, name, `- ${markdown}`);
  const img = outliner.locator("img.vr-image").first();
  await loaded(img, 300);
  const box = outliner.locator(".vr-image-box").first();
  const column = await outliner
    .locator(".vr-block-view")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  await box.hover();
  await drag(page, box.locator(".vr-image-handle"), 3000);
  await expect
    .poll(async () => (await readBlocks(page, name))[0]?.content)
    .toMatch(/\{:width \d+\}$/);
  const content = (await readBlocks(page, name))[0]?.content ?? "";
  const written = Number(/:width (\d+)/.exec(content)?.[1]);
  expect(written).toBeGreaterThan(300);
  expect(written).toBeLessThanOrEqual(Math.ceil(column));
  expect(await widthOf(img)).toBeLessThanOrEqual(column + 0.5);
});

test("B-789: the ⋯ menu downloads the picture and aligns it", async ({ page }, info) => {
  const name = runName(`Image Menu ${info.project.name}`, info);
  const { markdown, bytes } = await upload(page, name.replaceAll(" ", "-"), 64, 48);
  const md = markdown.replace(/^!\[[^\]]*\]/, "![garden shed]");
  const outliner = await openPage(page, name, `- ${md}\n- next`);
  const img = outliner.locator("img.vr-image").first();
  await loaded(img, 64);
  const box = outliner.locator(".vr-image-box").first();
  await box.hover();
  await box.getByRole("button", { name: "Image actions" }).click();
  const menu = page.getByRole("menu", { name: "Image actions" });
  await expect(menu).toBeVisible();
  // No Finder in a browser.
  await expect(menu.getByText("Show in Finder")).toHaveCount(0);

  const downloading = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Download" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("garden shed.png");
  expect(Buffer.compare(await readFile(await download.path()), bytes)).toBe(0);
  await expect(page.locator(".vr-image-toasts")).toContainText(
    "Downloaded garden shed.png to your browser's downloads folder.",
  );
  await expect(menu).toHaveCount(0);
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Centre it: written to the block, drawn in the middle of the column.
  await box.hover();
  await box.getByRole("button", { name: "Image actions" }).click();
  await page.getByRole("menuitemradio", { name: "Align centre" }).click();
  await expect
    .poll(async () => (await readBlocks(page, name))[0]?.content)
    .toBe(`${md}{:align "center"}`);
  const view = await outliner.locator(".vr-block-view").first().boundingBox();
  const pic = await img.boundingBox();
  if (!view || !pic) throw new Error("not on screen");
  expect(pic.x + pic.width / 2).toBeCloseTo(view.x + view.width / 2, 0);
  expect(await editingRowIndex(page, outliner)).toBe(-1);
});

test("B-789: a size Logseq wrote renders as a size, not as text", async ({ page }, info) => {
  const name = runName(`Image Logseq size ${info.project.name}`, info);
  const { markdown } = await upload(page, name.replaceAll(" ", "-"), 800, 400);
  const outliner = await openPage(page, name, `- ${markdown}{:height 236, :width 500} beside`);
  const img = outliner.locator("img.vr-image").first();
  await loaded(img, 800);
  expect(await widthOf(img)).toBeCloseTo(500, 0);
  await expect(outliner.locator(".vr-row").first()).not.toContainText("{:");
  await expect(outliner.locator(".vr-row").first()).toContainText("beside");
});
