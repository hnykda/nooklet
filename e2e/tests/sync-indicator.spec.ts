/**
 * The sync cloud stays still during routine sync (B-540).
 *
 * The owner: syncing "should be very silent, one shouldn't basically even know unless it's
 * necessary." The indicator used to be text that went "synced" → "syncing (1)" → "synced" on every
 * edit. Now its dot (`data-state`) only leaves "synced" once a problem has lasted ~2 s, while its
 * accessible name keeps telling the truth at every moment — which is what lets the first test prove
 * the edit really was pending at some point, so "the dot never moved" is not a vacuous pass.
 *
 * A flash is gone before an auto-retrying assertion looks, so the first test records every value
 * the attributes pass through with a `MutationObserver` and asserts on the whole recording.
 */

import { expect, type Page, test } from "@playwright/test";
import { clickAway, openEditing, readBlocks } from "../helpers/index.js";

interface TraceEntry {
  state: string | null;
  label: string | null;
  at: number;
}

declare global {
  interface Window {
    __syncTrace?: TraceEntry[];
  }
}

async function startTrace(page: Page): Promise<void> {
  await page.locator(".app-sync-indicator").evaluate((el) => {
    const trace: TraceEntry[] = [];
    window.__syncTrace = trace;
    const t0 = performance.now();
    new MutationObserver(() => {
      trace.push({
        state: el.getAttribute("data-state"),
        label: el.getAttribute("aria-label"),
        at: Math.round(performance.now() - t0),
      });
    }).observe(el, { attributes: true, attributeFilter: ["data-state", "aria-label"] });
  });
}

const readTrace = (page: Page): Promise<TraceEntry[]> =>
  page.evaluate(() => window.__syncTrace ?? []);

test("a routine edit's push and pull never change what the sync indicator shows", async ({
  page,
}) => {
  const name = "Quiet Sync Routine Edit";
  await openEditing(page, name, "- quiet start");
  const indicator = page.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute("data-state", "synced");
  await expect(indicator).toHaveAttribute("aria-label", "Synced");

  await startTrace(page);
  await page.keyboard.type(" then more", { delay: 20 });
  await clickAway(page);

  // The push landed, and the server's poke has had its pull answered.
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["quiet start then more"]);
  await expect(indicator).toHaveAttribute("aria-label", "Synced");
  // Past the attention delay, so a yellow dot that was merely late would have shown by now.
  await page.waitForTimeout(2_500);

  const trace = await readTrace(page);
  const pending = trace.filter((e) => /waiting to sync/.test(e.label ?? ""));
  expect(
    pending.length,
    `the edit should have been pending at some point: ${JSON.stringify(trace)}`,
  ).toBeGreaterThan(0);
  // Precondition, not the claim: on a loopback server a push takes well under the 2 s delay. If
  // this fails, the yellow dot showing would be correct and the test's premise is what broke.
  const settled = trace.findLast((e) => e.label === "Synced");
  expect((settled?.at ?? 0) - (pending[0]?.at ?? 0), JSON.stringify(trace)).toBeLessThan(2_000);

  expect(
    trace.filter((e) => e.state !== "synced"),
    `the dot should never have left "synced": ${JSON.stringify(trace)}`,
  ).toEqual([]);
  await expect(indicator).toHaveAttribute("data-state", "synced");
});

test("offline shows the offline state, and reconnecting clears it", async ({ page, context }) => {
  const name = "Quiet Sync Offline Edit";
  await openEditing(page, name, "- before offline");
  const indicator = page.locator(".app-sync-indicator");
  await expect(indicator).toHaveAttribute("data-state", "synced");

  await context.setOffline(true);
  // An edit made offline: its push fails, which is what puts the sync client in "offline".
  await page.keyboard.type(" typed offline", { delay: 20 });
  await clickAway(page);

  await expect(indicator).toHaveAttribute("data-state", "offline");
  await expect(indicator).toHaveAttribute(
    "aria-label",
    "Offline — changes are kept and sent when back online",
  );
  await expect(indicator).toHaveAttribute("title", /^Offline/);

  await context.setOffline(false);
  await expect(indicator).toHaveAttribute("data-state", "synced", { timeout: 15_000 });
  await expect(indicator).toHaveAttribute("aria-label", "Synced");
  expect((await readBlocks(page, name)).map((b) => b.content)).toEqual([
    "before offline typed offline",
  ]);
});
