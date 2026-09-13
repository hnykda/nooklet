/**
 * Where the local replica lives, and what the app does when it cannot live there.
 *
 * B-43: the replica is `opfs-sahpool`, which needs OPFS sync access handles inside a worker.
 * Playwright's WebKit build does not have them (`tools/probes/playwright-webkit-opfs.mjs`), and
 * before the fallback that meant every worker RPC rejected and the app rendered nothing — no
 * message, no outliner, unhandled `UnknownError`s in the console. The `webkit` project in
 * `playwright.config.ts` runs ONLY this file, so it doubles as the one place the WebKit engine is
 * exercised at all.
 */

import { expect, test } from "@playwright/test";

test("the shell says where the replica lives", async ({ page, browserName }) => {
  await page.goto("/journals");
  const indicator = page.locator(".app-sync-indicator");
  if (browserName === "webkit") {
    // No OPFS-in-workers here, so the honest label — not "synced", which would also be true.
    await expect(indicator).toHaveAttribute("aria-label", /^Not saved locally/);
    await expect(indicator).toHaveAttribute("data-state", "memory");
  } else {
    await expect(indicator).toHaveAttribute(
      "aria-label",
      /^(Synced|\d+ changes? waiting to sync)$/,
    );
    await expect(indicator).toHaveAttribute("data-state", "synced");
  }
});

test("the app is usable on an in-memory database", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "the fallback only engages where OPFS is unavailable");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/journals");
  const draft = page.locator(".vr-draft-input").first();
  const outliner = page.locator(".vr-outliner").first();
  await expect(draft.or(outliner)).toBeVisible();
  if (await draft.isVisible()) {
    await draft.fill("typed into memory");
    await draft.blur();
  }
  await expect(outliner).toBeVisible();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" and it worked", { delay: 20 });
  await expect(page.locator(".cm-content")).toHaveText(/and it worked$/);

  // The old failure mode was a wall of these. A warning in the console is fine; an uncaught
  // rejection is not.
  expect(errors).toEqual([]);
});
