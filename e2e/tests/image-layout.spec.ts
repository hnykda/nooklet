/**
 * B-703: an image's box is reserved before its bytes arrive, so the rows below it do not move when
 * it loads.
 *
 * The image response is held back (`page.route`) until the page has rendered with the size known,
 * then released; the row under the image must be where it was, and the image's box the size of
 * the loaded picture. Without the fix the image is 0×0 until it loads and the row below jumps by
 * the picture's height (and the size never arrives, so the wait for it fails).
 */
import { expect, type Page, test } from "@playwright/test";
import { api, openPage, runName } from "../helpers/index.js";
import { solidPng } from "../helpers/png.js";

async function upload(page: Page, name: string, width: number, height: number) {
  return api<{ markdown: string; width: number; height: number }>(page, "asset.upload", {
    filename: `${name}.png`,
    mime_type: "image/png",
    // A colour per test so its bytes (and so its asset) are its own, not a dedupe of another's.
    data_base64: solidPng(width, height, [40, (width * 7) % 256, (height * 13) % 256]).toString(
      "base64",
    ),
  });
}

async function topOf(page: Page, text: string): Promise<number> {
  const box = await page.locator(".vr-row", { hasText: text }).last().boundingBox();
  if (!box) throw new Error(`no row "${text}"`);
  return box.y;
}

for (const viewport of [
  { width: 1280, height: 800, label: "desktop" },
  { width: 390, height: 844, label: "phone width" },
]) {
  test(`B-703: the row below an image does not move when the image loads (${viewport.label})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const name = runName(`Image Layout ${viewport.label}`, info);
    // 1200×900 is wider than a phone and than the desktop column: it must be scaled down.
    const up = await upload(page, name.replaceAll(" ", "-"), 1200, 900);
    expect(up).toMatchObject({ width: 1200, height: 900 });

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/assets/*", async (route) => {
      await held;
      await route.continue();
    });

    // Bounded, not required: a build that never asks must fail on the movement below, not here.
    const sized = page
      .waitForResponse((r) => r.url().includes("/api/v1/asset.sizes"), { timeout: 5000 })
      .catch(() => undefined);
    await openPage(page, name, `- above the picture\n- ${up.markdown}\n- below the picture`);
    const img = page.locator("img.vr-image").first();
    // Measured once the size has had its chance to arrive and render — what is on screen then is
    // what a person sees while the picture is still on its way.
    await sized;
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    expect(await img.evaluate((el) => (el as HTMLImageElement).complete)).toBe(false);
    const reserved = await img.boundingBox();
    const belowBefore = await topOf(page, "below the picture");

    release();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1200);
    const loaded = await img.boundingBox();
    expect(await topOf(page, "below the picture")).toBeCloseTo(belowBefore, 0);
    expect(loaded?.width).toBeCloseTo(reserved?.width ?? -1, 0);
    expect(loaded?.height).toBeCloseTo(reserved?.height ?? -1, 0);
    // Scaled down to fit, aspect ratio kept (B-682): never wider than the viewport.
    expect(loaded?.width ?? 0).toBeLessThanOrEqual(viewport.width);
    expect((loaded?.width ?? 0) / (loaded?.height ?? 1)).toBeCloseTo(1200 / 900, 1);
    await expect(img).toHaveAttribute("width", "1200");
  });
}

test("B-703: a small image is reserved at its own size, not stretched", async ({ page }, info) => {
  const name = runName("Image Layout small", info);
  const up = await upload(page, name.replaceAll(" ", "-"), 120, 40);
  await openPage(page, name, `- ${up.markdown}\n- after`);
  const img = page.locator("img.vr-image").first();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(120);
  const box = await img.boundingBox();
  expect(box?.width).toBeCloseTo(120, 0);
  expect(box?.height).toBeCloseTo(40, 0);
  await expect(img).toHaveAttribute("width", "120");
});
