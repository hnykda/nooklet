/**
 * server-search: a device with no server at all (B-563's "Just this device") can search. Before,
 * the Search view asked only the server and said "Search needs a server — not available in
 * local-only mode" (B-577); the replica now has its own keyword index. Same "get into skip-sync
 * mode" pattern as `local-page-creation.spec.ts`.
 */
import { expect, test } from "@playwright/test";

test("with no server configured, search answers from the device and says so", async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  let searchRequests = 0;
  await page.route("**/api/v1/search", (route) => {
    searchRequests++;
    return route.abort();
  });
  await page.goto("/journals");
  // A genuinely local-only entry (no `baseUrl` — what Capacitor's "Just this device" makes, which
  // Chromium cannot run for real), seeded the way `graph-switcher.spec.ts` does it.
  await page.evaluate(() => {
    localStorage.setItem(
      "nooklet.graphs",
      JSON.stringify([{ id: "search-local", label: "Search Local Only", kind: "local" }]),
    );
    localStorage.setItem("nooklet.activeGraphId", "search-local");
  });
  await page.goto("/journals");
  await page.getByRole("button", { name: /Just this device/s }).click();

  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill("a localonlywalrus sighting, česky řečeno");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  // In-app navigation ("Open search"): a full load would re-run bootstrap and lose the "skipped"
  // choice.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.locator(".search-query-input").fill("localonlywalrus");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await expect(page.locator(".search-source")).toHaveText(
    "Keyword search on this device (local-only).",
  );
  await expect(page.getByText("Search needs a server")).toHaveCount(0);

  // Diacritics folded, as on the server.
  await page.locator(".search-query-input").fill("receno");
  await expect(page.locator(".search-result")).toHaveCount(1);
  expect(searchRequests).toBe(0);
});
