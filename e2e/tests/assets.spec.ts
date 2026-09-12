/**
 * Assets: an uploaded image referenced from a block must actually render — on every route the
 * page can be shown from, not only at the origin root.
 *
 * The markdown `asset.upload` hands back is `![alt](assets/<id>.<ext>)`, a RELATIVE path. Whether
 * that resolves depends on where the browser is: at `/journals` it is `/assets/…`, but at
 * `/page/Some Page` it is `/page/assets/…`, which the SPA fallback answers with index.html. This
 * spec exists so that difference is a test failure rather than a broken picture.
 */

import { expect, type Page, test } from "@playwright/test";

// A 1x1 transparent PNG (67 bytes). Anything that decodes is enough; naturalWidth tells the story.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      // From the session endpoint, not the injected global: the service worker serves the cached
      // shell on later navigations, and the global is whatever that shell was built with (B-19).
      const session = (await (await fetch("/api/session")).json()) as { token?: string };
      const token = session.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

/** Waits for the image to have decoded to real pixels — a broken image has naturalWidth 0. */
async function expectImageLoaded(page: Page, alt: string): Promise<void> {
  const img = page.locator(`img.vr-image[alt="${alt}"]`);
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

test("an uploaded image renders on the page route, not only at the root", async ({ page }) => {
  await page.goto("/journals");
  const up = (await api(page, "asset.upload", {
    filename: "dot.png",
    mime_type: "image/png",
    data_base64: PNG_1X1,
    alt: "a dot",
  })) as { markdown: string; url: string };
  expect(up.markdown).toMatch(/^!\[a dot\]\(assets\/[a-z0-9]+\.png\)$/);

  await api(page, "page.create", { name: "Assets Nested/Route", if_exists: "return" });
  await api(page, "page.append", { page: "Assets Nested/Route", markdown: `- ${up.markdown}` });

  // A namespaced page: the deepest route the app has, and the one a relative path breaks on.
  await page.goto("/page/Assets%20Nested/Route");
  await expectImageLoaded(page, "a dot");

  // And from the journal stream, where the same block shows up in references.
  await page.goto("/journals");
  await api(page, "page.append", { page: "today", markdown: `- also ${up.markdown}` });
  await page.reload();
  await expectImageLoaded(page, "a dot");
});
