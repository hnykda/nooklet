/**
 * A reload must not turn this tab into a follower of itself.
 *
 * A server graph's worker takes the replica's writer lock only if it is free at once, so a genuine
 * second tab follows instead of hanging (B-81, `views.spec.ts` "a second tab…"). But a reload or a
 * full navigation in the same tab can find the previous page load's worker still holding the lock
 * while it is torn down. That page came up as a follower on an in-memory replica, and what it
 * pulled was gone at the next load: a page seen online "did not exist yet" offline. Seen in full
 * e2e runs as `mermaid-lazy-cache.spec.ts` and `sync-connection-states.spec.ts` failing with two
 * device ids inside one test. The tab now remembers (sessionStorage) that it led this replica and
 * waits the teardown out (`apps/web/src/db/leader-tab.ts`).
 *
 * Made deterministic: another tab queues for the same lock before the reload, so it gets the lock
 * the moment the old worker lets go and keeps it for 1.5 s — the slow teardown, on demand.
 */

import { expect, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

test("a reload waits for its own previous page load's writer lock instead of following", async ({
  page,
}) => {
  await seedPage(page, "Reload Leader Page", "- kept on this device");
  await page.goto(pagePath("Reload Leader Page"));
  const indicator = page.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute("data-state", "synced", { timeout: 20_000 });

  const lockName = await page.evaluate(async () => {
    const held = (await navigator.locks.query()).held ?? [];
    return held.map((l) => l.name).find((n) => n?.startsWith("nooklet-db-writer")) ?? null;
  });
  expect(lockName).not.toBeNull();

  // Same origin, not the app: it starts no worker of its own.
  const other = await page.context().newPage();
  await other.goto("/healthz");
  await other.evaluate((name) => {
    const w = window as unknown as { __granted?: boolean };
    void navigator.locks.request(name as string, async () => {
      w.__granted = true;
      await new Promise((r) => setTimeout(r, 1_500));
    });
  }, lockName);

  await page.reload();
  // The other tab really did hold the lock across the reload's start.
  await expect
    .poll(() => other.evaluate(() => (window as unknown as { __granted?: boolean }).__granted))
    .toBe(true);
  await expect(page.locator(".vr-outliner").first()).toContainText("kept on this device", {
    timeout: 20_000,
  });
  await expect(indicator).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
  await other.close();
});
