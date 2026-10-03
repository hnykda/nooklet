/**
 * mermaid is not precached by the service worker, and still renders offline once seen.
 *
 * ADR 023 made mermaid the mermaid plugin's own dependency; the service worker then precached its
 * ~5 MB of chunks on every install, diagram or no diagram. `vite.config.ts` now leaves the chunks
 * only mermaid's lazy import reaches out of the precache, and a runtime rule keeps them on first
 * load. That rule is a function matcher because workbox's RegExp rules never matched (B-401) —
 * this spec is the evidence that the new one does.
 */
import { expect, type Page, test } from "@playwright/test";
import { openPage, pagePath } from "../helpers/index.js";

test.describe.configure({ timeout: 120_000 });

/** Every URL `sw.js` precaches, as served. */
async function precacheUrls(page: Page): Promise<string[]> {
  const res = await page.request.get("/sw.js");
  expect(res.status()).toBe(200);
  return [...(await res.text()).matchAll(/url:"([^"]+)"/g)].map((m) => m[1] as string);
}

test("the service worker precaches the app but none of mermaid's chunks", async ({ page }) => {
  const urls = await precacheUrls(page);
  // The positive control: the app shell is still there, so an empty list cannot pass this.
  expect(urls).toContain("index.html");
  expect(urls.some((u) => /^static\/index-[\w-]+\.js$/.test(u))).toBe(true);
  expect(urls.filter((u) => /mermaid|cytoscape|elk-|flowDiagram|dagre/.test(u))).toEqual([]);
});

test("a diagram rendered once renders again offline, from the runtime cache", async ({
  page,
  context,
}) => {
  await page.goto("/journals");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // Controlled from here on — otherwise the chunk requests would bypass the worker entirely.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 30_000,
    })
    .toBe(true);

  const chunkUrls: string[] = [];
  page.on("request", (r) => {
    if (/\/static\/.*\.js$/.test(r.url())) chunkUrls.push(r.url());
  });
  const name = "Mermaid Offline After First Use";
  const outliner = await openPage(page, name, "- ```mermaid\n  graph LR\n    Jaro --> Leto\n  ```");
  const diagram = outliner.locator('.vr-plugin-fence[data-lang="mermaid"] svg');
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  const core = chunkUrls.find((u) => /\/static\/mermaid\.core-/.test(u));
  expect(core, "mermaid.core was loaded for the diagram").toBeTruthy();

  // The runtime rule matched: the chunk is in its cache, which it never would be with a RegExp
  // rule anchored at `^\/` (B-401).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const cache = await caches.open("lazy-chunks");
          return (await cache.keys()).map((r) => new URL(r.url).pathname);
        }),
      { timeout: 15_000 },
    )
    .toContain(new URL(core as string).pathname);

  // Offline, a fresh document: every chunk now has to come from the service worker.
  await context.setOffline(true);
  try {
    await page.goto(pagePath(name));
    const again = page.locator('.vr-outliner .vr-plugin-fence[data-lang="mermaid"] svg').first();
    await expect(again).toBeVisible({ timeout: 30_000 });
    await expect(again).toContainText("Jaro");
  } finally {
    await context.setOffline(false);
  }
});
