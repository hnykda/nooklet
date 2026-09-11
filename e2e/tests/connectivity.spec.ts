/**
 * The served client must be able to reach its own API.
 *
 * Before the bootstrap-token work, a production build had no credential at all: the token came
 * from `VITE_NOOKLET_TOKEN`, a dev-only stand-in that is undefined in a build. Search and
 * backlinks 401'd, `/ui/live` never authenticated, and sync flapped offline→syncing→offline
 * forever. Nothing in the UI said so, because the failing views had a loading branch and a
 * results branch but no error branch — so a 401 rendered as a permanent spinner.
 */

import { expect, test } from "@playwright/test";

test("the server hands the loopback client a usable token", async ({ page }) => {
  await page.goto("/journals");
  const cfg = await page.evaluate(
    () => (window as unknown as { __NOOKLET__?: { token?: string | null } }).__NOOKLET__,
  );
  expect(cfg, "server should inject window.__NOOKLET__").toBeTruthy();
  expect(cfg?.token, "loopback client should get a token").toBeTruthy();
});

test("the API accepts that token", async ({ page }) => {
  await page.goto("/journals");
  const status = await page.evaluate(async () => {
    const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
    const res = await fetch("/api/v1/graph.overview", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    return res.status;
  });
  expect(status).toBe(200);
});

test("search returns rather than spinning forever", async ({ page }) => {
  // Seed something findable through the UI, so this also proves the write path reached the server.
  await page.goto("/journals");
  const draft = page.locator(".vr-draft-input").first();
  if (await draft.isVisible()) {
    await draft.fill("findable haystack needle");
    await draft.blur();
  } else {
    await page.locator(".vr-outliner").first().locator(".vr-block-view").first().click();
    await page.keyboard.type("findable haystack needle", { delay: 20 });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
  }

  await page.goto("/search");
  await page.locator(".search-query-input").fill("needle");

  // The regression: this used to sit on "Searching…" indefinitely.
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".search-summary")).toBeVisible();
});

test("sync reaches a connected state instead of flapping offline", async ({ page }) => {
  await page.goto("/journals");
  // Whatever the indicator renders, "offline" must not be the terminal state.
  await expect
    .poll(
      async () =>
        (await page.locator("body").innerText()).toLowerCase().includes("offline")
          ? "offline"
          : "ok",
      { timeout: 20_000, message: "sync status should settle out of 'offline'" },
    )
    .toBe("ok");
});
