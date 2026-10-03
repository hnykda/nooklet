/**
 * B-568: a device with no server at all (B-563's "Just this device") never reaches
 * `packages/server/src/ref-pages.ts` — that mechanism is server-only by design — so a `[[ref]]`
 * typed there used to never create the page. `data/local-ref-pages.ts` is the client-side
 * equivalent; this proves it end to end, in a real browser, with no server involved at all (the
 * same "get into skip-sync mode" pattern as `sync-timeout.spec.ts`, same session).
 */
import { expect, test } from "@playwright/test";
import { pagePath } from "../helpers/index.js";

test("typing [[a new page]] with no server configured creates the page locally", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  await page.goto("/journals");
  // ADR 025: credentials live in the graph list now (`nooklet.graphs`/`nooklet.activeGraphId`),
  // not the single `nooklet.deviceToken` key this used to clear.
  await page.evaluate(() => {
    localStorage.removeItem("nooklet.graphs");
    localStorage.removeItem("nooklet.activeGraphId");
  });
  await page.goto("/journals");

  await page.getByRole("button", { name: /Just this device/s }).click();

  const draft = page.locator(".journal-day-today .vr-draft-input").first();
  await expect(draft).toBeVisible();
  await draft.fill("see [[Local Only New Page]]");
  await page.keyboard.press("Enter");
  // Exit editing so the reference renders as a link — clicking it (not a full navigation, which
  // would re-run main.tsx's bootstrap and lose the in-memory "skipped" choice, re-showing
  // ConnectView) is also exactly what the owner's own bug report did.
  await page.keyboard.press("Escape");

  const link = page.locator("a.vr-page-ref", { hasText: "Local Only New Page" }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(new RegExp(pagePath("Local Only New Page").replace(/ /g, "%20")));
  await expect(page.locator("h1")).toHaveText("Local Only New Page");
  await expect(page.getByText("This page doesn't exist yet.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Create /s })).toHaveCount(0);
});
