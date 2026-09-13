/**
 * Runs FIRST, deliberately: the filename is alphabetically ahead of every other spec.
 *
 * This behaviour only exists on a journal day that has no page yet, and today's journal is global
 * state that several other specs write to — `editing.spec.ts` seeds it in its very first test. So
 * this needs a genuinely fresh today, and the only reliable way to get one against a shared server
 * is to go first. Deleting and re-creating the day instead looked tempting and was not equivalent:
 * the client has its own replica to reconcile, and the sequence behaved differently.
 */

import { expect, test } from "@playwright/test";
import { api, isoOffset } from "../helpers/index.js";

test("Enter on a brand-new journal day continues into the next bullet", async ({ page }) => {
  await page.goto("/journals");
  // Scoped to TODAY: an "Upcoming" section can render above it, so an unscoped `.first()` would
  // pick whichever day happens to be on top.
  const today = page.locator(".journal-day-today");
  const draft = today.locator(".vr-draft-input").first();
  await expect(draft).toBeVisible();

  await draft.fill("first thought");
  await page.keyboard.press("Enter");

  // The regression: Enter committed the text and dropped out of editing entirely, so the only way
  // to keep writing was to find a bullet and click it.
  await expect(today.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("second thought");

  const outliner = today.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect(outliner).toContainText("first thought");
  await expect(outliner).toContainText("second thought");

  // And both reached the server before this test's browser context — and its replica — is thrown
  // away. Without this wait, whether today's journal holds these two blocks for every later spec
  // was a race against the push debounce, and a spec that assumed either outcome failed only
  // sometimes (B-233). Waiting makes the shared state the same on every run.
  await expect
    .poll(async () => {
      const read = await api<{ tree: { content: string }[] }>(page, "page.read", {
        page: isoOffset(0),
        format: "json",
      }).catch(() => ({ tree: [] }));
      return read.tree.map((n) => n.content);
    })
    .toEqual(["first thought", "second thought"]);
});
