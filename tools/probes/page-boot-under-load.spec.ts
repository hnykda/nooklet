/**
 * Probe (2026-09-13, m10/tests-desktop, B-323): how long does a fresh browser context take to get
 * from `goto(/page/<name>)` to a rendered page, and where does that time go?
 *
 * `references.spec.ts` "shows a count and collapses" once saw only the page view's "Loading…" for
 * its whole 10 s expectation. `PageView` shows "Loading…" while `usePageByName`'s first fetch is
 * pending, and every worker query waits for `db.worker.ts#openDb` — leader lock, sqlite-wasm,
 * OPFS, and on a fresh replica the whole `/sync/snapshot` bootstrap. This measures that window on
 * the spec's exact sequence (load `/journals` for a token, seed through `page.evaluate`, navigate
 * away), per phase, plus what storage the second load ended up on (a second load that starts
 * while the first one's worker still holds the writer lock becomes a follower on an in-memory
 * replica, B-81).
 *
 * Prints one JSON line per iteration; it does not assert. To re-run, copy it into `e2e/tests/`
 * and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium --repeat-each=20
 * then delete the copy. For "under load", start busy node loops first (`node -e 'for(;;){}'`,
 * two to four per core) and kill them after.
 */
import { expect, type Page, test } from "@playwright/test";
import { pagePath } from "../helpers/index.js";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

test("probe: fresh-context page boot timing", async ({ page }, info) => {
  test.setTimeout(120_000);
  const target = `Boot Probe ${info.repeatEachIndex} ${Date.now()}`;
  const t = (t0: number) => Date.now() - t0;

  const tJournals = Date.now();
  await page.goto("/journals");
  const journalsCommitted = t(tJournals);
  await api(page, "page.create", { name: target, if_exists: "return" });
  await api(page, "page.append", { page: target, markdown: "- the target" });
  const seeded = t(tJournals);

  const snapshots: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sync/snapshot")) snapshots.push(Date.now());
  });
  // Timestamps from inside the page, relative to its navigation start, so the probe's own
  // polling cannot distort them.
  await page.addInitScript(() => {
    const w = window as unknown as { __boot: Record<string, number> };
    w.__boot = {};
    const mark = () => {
      const now = Math.round(performance.now());
      const loading = document.querySelector(".page-view-loading") !== null;
      if (loading && w.__boot.loading === undefined) w.__boot.loading = now;
      if (!loading && w.__boot.loading !== undefined) w.__boot.loadingGone ??= now;
      if (document.querySelector(".page-title-row") && w.__boot.title === undefined)
        w.__boot.title = now;
    };
    new MutationObserver(mark).observe(document, { childList: true, subtree: true });
  });
  const t0 = Date.now();
  await page.goto(pagePath(target));
  const committed = t(t0);
  await expect(page.locator(".page-title-row")).toBeVisible({ timeout: 90_000 });
  const rendered = t(t0);
  const boot = await page.evaluate(
    () => (window as unknown as { __boot: Record<string, number> }).__boot,
  );
  const indicator = await page.locator(".app-sync-indicator").textContent();
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
  console.log(
    JSON.stringify({
      i: info.repeatEachIndex,
      journalsCommitted,
      seeded,
      committed,
      rendered,
      boot,
      snapshotRequestsAfterNav: snapshots.map((s) => s - t0),
      indicator,
      controlled,
    }),
  );
});
