/**
 * B-738 / ADR 035: pictures load slowly, even the second time.
 *
 * 1. The `<img>` in a note asks the server for a resized copy (`/assets/:id?w=<w>`), never the
 *    original: the response is a WebP as wide as the variant, and no request for the original is
 *    made until the viewer opens.
 * 2. A picture shown once is answered by the service worker afterwards. Its `/assets/` rule never
 *    matched (B-401), and in WKWebView a request the worker lets through skips the HTTP cache, so
 *    the Mac app downloaded every picture again on every showing
 *    (`tools/probes/image-cache/probe.mjs`). Chromium and WebKit both run this.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, openPage, pagePath, runName } from "../helpers/index.js";
import { solidPng } from "../helpers/png.js";

test.describe.configure({ timeout: 90_000 });

async function upload(page: Page, name: string, width: number, height: number, seed: number) {
  return api<{ id: string; markdown: string; url: string }>(page, "asset.upload", {
    filename: `${name}.png`,
    mime_type: "image/png",
    // Its own colour per test and engine, so the bytes (and the asset) are not another test's.
    data_base64: solidPng(width, height, [seed % 256, (seed * 7) % 256, 90]).toString("base64"),
  });
}

/** Every `/assets/` request the page makes, as URLs. */
function assetRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (/\/assets\//.test(new URL(r.url()).pathname)) urls.push(r.url());
  });
  return urls;
}

async function decoded(page: Page, selector = ".vr-outliner img.vr-image"): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate(
          (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth,
        ),
    )
    .toBeGreaterThan(0);
}

test("B-738: the picture in a note is a resized copy, not the original", async ({
  page,
  browserName,
}, info) => {
  const name = runName(`Image Variant ${browserName}`, info);
  const up = await upload(page, name.replaceAll(" ", "-"), 2400, 1600, 11 + info.retry);
  const requests = assetRequests(page);
  const responses: Array<{ url: string; type: string | null }> = [];
  page.on("response", (r) => {
    if (/\/assets\//.test(new URL(r.url()).pathname)) {
      responses.push({ url: r.url(), type: r.headers()["content-type"] ?? null });
    }
  });
  await openPage(page, name, `- ${up.markdown}`);
  await decoded(page);

  const img = page.locator(".vr-outliner img.vr-image").first();
  const shown = await img.evaluate((el) => ({
    src: (el as HTMLImageElement).currentSrc,
    natural: (el as HTMLImageElement).naturalWidth,
    drawn: el.getBoundingClientRect().width,
    dpr: window.devicePixelRatio,
  }));
  const w = Number(new URL(shown.src).searchParams.get("w"));
  expect([480, 960, 1600]).toContain(w);
  // Covers what is drawn, in device pixels, and is the smallest that does.
  expect(w).toBeGreaterThanOrEqual(Math.ceil(shown.drawn * shown.dpr));
  expect(shown.natural).toBe(w);
  // Every request for this picture was for that copy; the original never left the server.
  const mine = requests.filter((u) => u.includes(up.id));
  expect(mine.length).toBeGreaterThan(0);
  for (const u of mine) expect(new URL(u).searchParams.get("w")).toBe(String(w));
  const answer = responses.find((r) => r.url.includes(up.id));
  expect(answer?.type).toBe("image/webp");

  // The viewer shows the original.
  await img.click();
  const big = page.locator("img.image-viewer-img");
  await expect(big).toHaveJSProperty("naturalWidth", 2400);
  // The original: the asset's key (B-737) and nothing else.
  const original = new URL(await big.evaluate((el) => (el as HTMLImageElement).currentSrc));
  expect([...original.searchParams.keys()]).toEqual(["k"]);
});

test("B-738: a picture shown once comes from the service worker after that, offline too", async ({
  page,
  context,
  browserName,
}, info) => {
  const name = runName(`Image Cached ${browserName}`, info);
  const up = await upload(page, name.replaceAll(" ", "-"), 1800, 1200, 101 + info.retry);
  // Controlled by the worker from here on — otherwise the picture's requests bypass it entirely.
  await page.goto("/journals");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 30_000,
    })
    .toBe(true);

  await openPage(page, name, `- ${up.markdown}\n- below`);
  await decoded(page);
  const src = await page
    .locator(".vr-outliner img.vr-image")
    .first()
    .evaluate((el) => (el as HTMLImageElement).currentSrc);
  expect(new URL(src).searchParams.has("w")).toBe(true);
  expect(new URL(src).searchParams.has("k")).toBe(true); // B-737: the cache key includes the key
  // The worker kept it.
  await expect
    .poll(() =>
      page.evaluate(
        async (url) =>
          (await caches.open("asset-variants").then((c) => c.match(url))) !== undefined,
        src,
      ),
    )
    .toBe(true);

  // A new document showing the same picture: answered by the worker, not the network.
  const fromWorker: boolean[] = [];
  page.on("response", (r) => {
    if (r.url() === src) fromWorker.push(r.fromServiceWorker());
  });
  await page.goto(pagePath(name));
  await decoded(page);
  expect(fromWorker.length).toBeGreaterThan(0);
  expect(fromWorker.every(Boolean)).toBe(true);

  // And with no network at all. Chromium only: Playwright's WebKit fails an offline reload with
  // "WebKit encountered an internal error" before the page gets a say.
  if (browserName !== "chromium") return;
  await context.setOffline(true);
  try {
    await page.reload();
    await decoded(page);
  } finally {
    await context.setOffline(false);
  }
});
