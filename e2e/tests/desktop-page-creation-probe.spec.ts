/**
 * THROWAWAY PROBE — B-568 desktop-path investigation (2026-09-15). Kept per this repo's own
 * convention ("a claim you can re-run beats a claim you remember") since it reproduces a real,
 * separate bug found along the way — see the second test. Real server (loopback, real token), not
 * the skip-sync path `local-page-creation.spec.ts` covers.
 */
import { expect, test } from "@playwright/test";

test("probe: [[ref]] with a real server — creates the page correctly (corroborates B-568)", async ({
  page,
  request,
}) => {
  await page.goto("/journals");
  const token = await page.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token,
  );
  expect(token).toBeTruthy();

  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill("see [[Desktop Probe Page]]");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2000);

  const serverRes = await request.post("/api/v1/search", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { query: "Desktop Probe Page", scope: "pages", limit: 5 },
  });
  const serverBody = await serverRes.json();
  expect(serverBody.hits?.[0]?.page).toBe("Desktop Probe Page");

  const link = page.locator("a.vr-page-ref", { hasText: "Desktop Probe Page" }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByText("This page doesn't exist yet.")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("Desktop Probe Page");
});

/**
 * NOT a B-568 bug — a separate, real finding. `page.goto()` to a URL is a full cold client
 * bootstrap (fresh worker, fresh driver open), unlike an in-app `<A>` navigation. The page
 * snapshot at timeout showed the shelf/header had already resolved ("0 blocks on Desktop Probe
 * Page" — proving the page itself loaded fine) while the block-tree content area stayed on
 * "Loading…" indefinitely. A freshly-referenced page (whether created by B-568's client-side path
 * or the server's own `ref-pages.ts` — both produce a page with zero blocks until someone writes
 * into it) hitting this on the very first cold load anyone gives it is a real, user-visible gap:
 * `usePageTree`/`BlockTree`'s handling of a zero-block page on a cold worker start looks like the
 * likely place, not investigated further here — out of this probe's scope, logged for follow-up.
 */
test("probe: direct cold navigation to a zero-block page hangs on 'Loading…' — logged, not fixed here", async ({
  page,
}) => {
  await page.goto("/journals");
  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill("see [[Cold Nav Zero Block Page]]");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  // Cold nav directly to the URL — not an in-app link click — is what reproduces it.
  await page.goto("/page/Cold%20Nav%20Zero%20Block%20Page");
  const stuckLoading = await page
    .getByText("Loading…")
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  // Documented as a known-open finding, not asserted as a hard failure here — see the header
  // comment above. Flip this to `expect(stuckLoading).toBe(false)` once it has its own bug entry
  // and fix.
  console.log("Zero-block page, cold nav — stuck on 'Loading…':", stuckLoading);
});
