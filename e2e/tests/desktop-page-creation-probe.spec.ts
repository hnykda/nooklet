/**
 * THROWAWAY PROBE — B-568 desktop-path investigation (2026-09-15). Kept per this repo's own
 * convention ("a claim you can re-run beats a claim you remember") since it reproduces a real,
 * separate bug found along the way — see the second test. Real server (loopback, real token), not
 * the skip-sync path `local-page-creation.spec.ts` covers.
 *
 * Each test types its `[[ref]]` into its OWN seeded page, not today's journal draft. The draft only
 * exists while today has no blocks, so it was gone as soon as anything — the first test here, or any
 * earlier spec on the shared server — had written to today: both tests then failed at the draft
 * locator (~10.4 s, the expect timeout) before reaching what they probe (2026-10-03, B-581).
 */
import { expect, test } from "@playwright/test";
import { api, openEditing, pagePath, runName } from "../helpers/index.js";

test("probe: [[ref]] with a real server — creates the page correctly (corroborates B-568)", async ({
  page,
}, info) => {
  const target = runName("Desktop Probe Page", info);
  await openEditing(page, runName("Desktop Probe Host", info), "- start");
  await page.keyboard.type(` see [[${target}]]`);
  await page.keyboard.press("Escape");

  await expect
    .poll(async () => {
      const body = await api<{ hits?: Array<{ page?: string }> }>(page, "search", {
        query: target,
        scope: "pages",
        limit: 5,
      });
      return body.hits?.map((h) => h.page);
    })
    .toContain(target);

  const link = page.locator("a.vr-page-ref", { hasText: target }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByText("This page doesn't exist yet.")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText(target);
});

/**
 * B-581 — NOT a B-568 bug, a separate report: a direct cold navigation (`page.goto()`, a full
 * client bootstrap, unlike an in-app `<A>` click) to a page with zero blocks was said to stay on
 * "Loading…" forever. The original version of this probe never showed that: it read
 * `isVisible({ timeout: 8000 })`, and `isVisible` does not wait — the timeout is ignored — so its
 * `true` was "Loading…" at the first instant after `goto`, which every cold load shows. Re-measured
 * 2026-10-03 with a real wait, it clears. So this now asserts the claim instead of logging it.
 */
test("probe: direct cold navigation to a zero-block page does not hang on 'Loading…' (B-581)", async ({
  page,
}, info) => {
  const target = runName("Cold Nav Zero Block Page", info);
  await openEditing(page, runName("Cold Nav Host", info), "- start");
  await page.keyboard.type(` see [[${target}]]`);
  await page.keyboard.press("Escape");
  // The page must exist (zero blocks) before the cold load, or this probes "page not found".
  await expect
    .poll(async () => {
      const out = await api<{ items: Array<{ name: string }> }>(page, "page.list", {
        prefix: "Cold Nav Zero",
      });
      return out.items.map((p) => p.name);
    })
    .toContain(target);

  // Cold nav directly to the URL — not an in-app link click — is what the report was about.
  await page.goto(pagePath(target));
  const loadingAtOnce = await page.getByText("Loading…").isVisible();
  const t0 = Date.now();
  await expect(page.locator("h1")).toHaveText(target);
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 15_000 });
  console.log(
    `B-581 probe: "Loading…" visible right after goto: ${loadingAtOnce}; gone after ${Date.now() - t0} ms`,
  );
});
