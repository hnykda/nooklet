/**
 * Probe (2026-09-13, m10/tests-desktop, B-403): can a fresh browser's first sync throw away the
 * "Older changes" page that `review-reactivity.spec.ts`'s B-131 test is waiting for?
 *
 * Seen once in a full e2e chunk: after the retry click, `.history-batch` stayed at 25 for 10 s. The
 * History view's first page comes over HTTP; the replica's first `/sync/snapshot` lands whenever the
 * DB worker gets there, and its `onBootstrap` ChangeEvent refetches that first page — which, by
 * design (B-132), drops appended older pages and discards an older page still in flight.
 *
 * A: the test's flow, with the snapshot held until the retried older page is in flight, then let go
 *    before that page's answer. Expect: the first page is fetched again and the count stays 25.
 * B: the same page opened as a page first (its rows come from the replica, so the replica is
 *    bootstrapped), then History loaded. Expect: no second snapshot, one first-page fetch, 26.
 * C: nothing forced - ten runs of each flow, "cold" (the test at 70c9bb9) and "warm" (B then
 *    History, the test since B-403), logging in the page when each `page.history` fetch started (>),
 *    answered (<) or failed (!) and when "Older changes" was clicked. Asserts nothing about the cold
 *    flow's count (it is a race); prints it.
 *
 * Results 2026-09-13. A 3 of 3 at 25, the first page fetched five times: once on mount, then four
 * within 1-2 ms of each other 20-50 ms after the snapshot was let go (one per table the bootstrap
 * event names - B-404). B 3 of 3 at 26, one first-page fetch, no second snapshot. C under 56 busy
 * loops (load average about 70): cold 9 of 10 at 26 and one at 25, logged as
 * `click@475 older>475 first>490 first>491 first>491 first>491 older<491 first<493 … first<496` -
 * the refetches started 15 ms after the retry click, and their answers cleared the older page it had
 * just appended; in the other nine cold runs the refetches had been answered 3-195 ms BEFORE the
 * retry click. Warm 10 of 10 at 26, one first-page fetch each. The whole file again with NO busy
 * loops (load average 30-50 from other work): A and B as before; cold 3 of 10 at 25, each with the
 * refetches starting 0-21 ms after the older page's answer. Of the seven at 26, five had no refetch
 * at all yet when the count was read (the test finished before the worker's first sync), one read
 * the count between a refetch starting after the older answer and its answer being applied, and
 * one had the refetches answered 25 ms before the retry click. Warm 10 of 10 at 26. So this is a race between the worker's start and the test's own speed, not load: the
 * faster the test runs relative to the worker, the likelier the refetch lands after the retry.
 *
 * To re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, pagePath, runName, seedPage } from "../helpers/index.js";

async function seed26(page: Page, name: string): Promise<void> {
  await seedPage(page, name, "- zero");
  for (let i = 1; i <= 25; i++) await api(page, "page.append", { page: name, markdown: `- ${i}` });
}

test("probe A: the first snapshot landing while the retried older page is in flight", async ({
  page,
}, info) => {
  const name = runName("Probe Older Snapshot A", info);
  await seed26(page, name);

  let releaseSnapshot: () => void = () => {};
  const snapshotHeld = new Promise<void>((r) => {
    releaseSnapshot = r;
  });
  await page.route("**/sync/snapshot", async (route) => {
    await snapshotHeld;
    await route.continue();
  });
  let releaseOlder: () => void = () => {};
  const olderHeld = new Promise<void>((r) => {
    releaseOlder = r;
  });
  let firstPageFetches = 0;
  let olderFetches = 0;
  let releasedAt = 0;
  // When each first-page fetch starts, in ms after the snapshot is let go (negative: before).
  const firstPageAt: number[] = [];
  await page.route("**/api/v1/page.history", async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string };
    if (body.cursor === undefined) {
      firstPageFetches++;
      firstPageAt.push(releasedAt === 0 ? -1 : Date.now() - releasedAt);
      await route.continue();
      return;
    }
    olderFetches++;
    if (olderFetches === 1) {
      await route.abort("failed");
      return;
    }
    await olderHeld;
    await route.continue();
  });

  await page.goto(`/history/${encodeURIComponent(name)}`);
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(25);
  await page.locator(".history-more").click();
  await expect(page.locator(".history-error[role='alert']")).toContainText(
    "Could not load older changes",
  );
  await page.locator(".history-more").click();
  await expect.poll(() => olderFetches).toBe(2);

  const refetched = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/page.history") &&
      (r.request().postDataJSON() as { cursor?: string }).cursor === undefined,
  );
  releasedAt = Date.now();
  releaseSnapshot();
  await refetched;
  releaseOlder();
  await page.waitForTimeout(3_000);
  const count = await batches.count();
  console.log(JSON.stringify({ probe: "A", firstPageFetches, firstPageAt, olderFetches, count }));
  expect(firstPageFetches).toBeGreaterThan(1);
  expect(count).toBe(25);
});

test("probe B: History opened on a replica that has already bootstrapped", async ({
  page,
}, info) => {
  const name = runName("Probe Older Snapshot B", info);
  await seed26(page, name);

  let snapshots = 0;
  await page.route("**/sync/snapshot", async (route) => {
    snapshots++;
    await route.continue();
  });
  let firstPageFetches = 0;
  let olderFetches = 0;
  await page.route("**/api/v1/page.history", async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string };
    if (body.cursor === undefined) {
      firstPageFetches++;
      await route.continue();
      return;
    }
    olderFetches++;
    if (olderFetches === 1) {
      await route.abort("failed");
      return;
    }
    // Hold the retried older page a while: nothing may refetch the first page meanwhile.
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });

  await page.goto(pagePath(name));
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(26);
  const snapshotsBefore = snapshots;

  await page.goto(`/history/${encodeURIComponent(name)}`);
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(25);
  await page.locator(".history-more").click();
  await expect(page.locator(".history-error[role='alert']")).toContainText(
    "Could not load older changes",
  );
  await page.locator(".history-more").click();
  await expect(batches).toHaveCount(26);
  await page.waitForTimeout(1_000);
  const count = await batches.count();
  console.log(
    JSON.stringify({
      probe: "B",
      snapshotsBefore,
      snapshots,
      firstPageFetches,
      olderFetches,
      count,
    }),
  );
  expect(snapshots).toBe(snapshotsBefore);
  expect(firstPageFetches).toBe(1);
  expect(count).toBe(26);
});

/** C's in-page log: each `page.history` fetch as first/older with start (>), answer (<) or
 * failure (!), and each click on "Older changes", in `performance.now()` ms. */
async function logHistoryFetches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __probeLog: string[] }).__probeLog = log;
    const t = () => Math.round(performance.now());
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("page.history")) return orig(input, init);
      const tag = String(init?.body ?? "").includes("cursor") ? "older" : "first";
      log.push(`${tag}>${t()}`);
      try {
        const res = await orig(input, init);
        log.push(`${tag}<${t()}`);
        return res;
      } catch (e) {
        log.push(`${tag}!${t()}`);
        throw e;
      }
    };
    document.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element).closest?.(".history-more")) log.push(`click@${t()}`);
      },
      true,
    );
  });
}

async function unforcedFlow(page: Page, name: string, warm: boolean): Promise<number> {
  await seed26(page, name);
  if (warm) {
    await page.goto(pagePath(name));
    await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(26);
  }
  await logHistoryFetches(page);
  await page.route("**/api/v1/page.history", async (route) => {
    const body = route.request().postDataJSON() as { cursor?: string };
    if (body.cursor !== undefined) await route.abort("failed");
    else await route.continue();
  });
  await page.goto(`/history/${encodeURIComponent(name)}`);
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(25);
  await page.locator(".history-more").click();
  await expect(page.locator(".history-error[role='alert']")).toContainText(
    "Could not load older changes",
  );
  await expect(page.locator(".history-more")).toBeEnabled();
  await page.unroute("**/api/v1/page.history");
  await page.locator(".history-more").click();
  await expect(batches)
    .toHaveCount(26)
    .catch(() => {});
  const count = await batches.count();
  const log = await page.evaluate(() => (window as unknown as { __probeLog: string[] }).__probeLog);
  console.log(JSON.stringify({ probe: "C", warm, count, log: log.join(" ") }));
  return count;
}

for (let i = 0; i < 10; i++) {
  test(`probe C cold ${i}`, async ({ page }) => {
    await unforcedFlow(page, `Probe Older Cold ${i} ${Date.now()}`, false);
  });
  test(`probe C warm ${i}`, async ({ page }) => {
    expect(await unforcedFlow(page, `Probe Older Warm ${i} ${Date.now()}`, true)).toBe(26);
  });
}
