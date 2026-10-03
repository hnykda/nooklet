/**
 * B-564: a `/sync/*` or `/api/v1/*` request that never resolves (rather than failing fast) used
 * to leave every worker-backed view — the journal draft, the sidebar, everything — on "Loading…"
 * forever, because `db.start()` awaits `SyncClient.bootstrap()` before returning and every worker
 * RPC awaits the same `dbPromise`. A real server always answers, even with a 401, so this only
 * ever showed up somewhere with no server behind the relative URL at all (the Capacitor iOS shell
 * with no server configured: `capacitor://localhost/sync/...` has no route, unlike this real dev
 * server) — reproduced here by forcing the sync endpoints to hang in an ordinary browser session,
 * which is enough to prove the fix (a bounded timeout, `sync/http-transport.ts`'s
 * `SYNC_TIMEOUT_MS`) rather than anything Capacitor-specific.
 */
import { expect, test } from "@playwright/test";

test("a hung sync backend times out instead of stalling the outliner forever", async ({ page }) => {
  await page.goto("/journals");
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null, reason: "non_loopback_host" }),
    }),
  );
  // Never resolves — what an unconfigured Capacitor build's relative fetch effectively gets,
  // since there is no server at all behind `capacitor://localhost/sync/*`.
  await page.route("**/sync/**", () => new Promise(() => {}));
  // ADR 025: the single `nooklet.deviceToken` key this used to clear is gone — credentials now
  // live in the graph list (`nooklet.graphs`/`nooklet.activeGraphId`), cleared the same way, so
  // this run starts from the same "nothing configured yet" state a fresh device would.
  await page.evaluate(() => {
    localStorage.removeItem("nooklet.graphs");
    localStorage.removeItem("nooklet.activeGraphId");
  });
  await page.goto("/journals");

  await page.getByRole("button", { name: /Just this device/s }).click();

  // Stuck on the pending placeholder immediately after — this is the bug's signature, not yet
  // the fix; asserting it here pins down what "before" looked like.
  await expect(page.locator(".vr-draft-pending")).toBeVisible();

  // The 10s timeout (`SYNC_TIMEOUT_MS`) clears and the real, editable draft takes over.
  await expect(page.locator(".vr-draft-input")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".vr-draft-pending")).toHaveCount(0);
});
