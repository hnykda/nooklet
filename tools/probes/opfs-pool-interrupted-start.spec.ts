/**
 * Probe (2026-09-13, verification of m10/tests-desktop, B-323): does a REAL first start cut short
 * leave the replica's OPFS pool short, and does the app come up on the next start anyway?
 *
 * `e2e/tests/opfs-pool.spec.ts` builds the state it believes an interrupted first start leaves (one
 * zero-length file in `.nooklet-opfs-sahpool/.opaque`). This produces the state the honest way: a
 * fresh browser context loads `/journals` (the app's first ever start in that profile), a
 * same-origin navigation to `/icon.svg` tears it down after `delay` ms, and the pool's files are
 * counted; the same context then opens a seeded page (the next start) and must render and write it.
 *
 * Prints one JSON line per delay; asserts only that the next start renders. To re-run, copy it into
 * `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 *
 * Result 2026-09-13 (idle, delays 70-113.5 ms in 1.5 ms steps, two repeats): the teardown lands
 * either before the pool directory exists or after all six files, except in a ~30 ms window; there,
 * 6 of 60 left 1, 1, 1, 2, 4 and 5 files, and on the fixed client every next start rendered and
 * synced. With the fix commented out, the same run left 3 and 4 files and those next starts still
 * rendered — the database and its journal need only two — so only a one-file pool kills the old
 * client. Coarse delays 0-400 ms: 0 of 12 short.
 */
import { expect, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

// Idle, the window is ~75-100 ms after commit; widen it for a loaded machine.
const DELAYS = Array.from({ length: 30 }, (_, i) => 70 + i * 1.5);

test("probe: interrupted first start vs the OPFS pool", async ({ browser }, info) => {
  test.setTimeout(600_000);
  const name = `Opfs Interrupt Probe ${info.repeatEachIndex}`;
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await seedPage(page, name, "- seeded");
    await ctx.close();
  }
  let short = 0;
  let dead = 0;
  for (const delay of DELAYS) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (/SAH pool|CANTOPEN/.test(m.text())) errors.push(m.text().slice(0, 120));
    });
    await page.goto("/journals", { waitUntil: "commit" });
    await page.waitForTimeout(delay);
    await page.goto("/icon.svg");
    await page.waitForTimeout(500);
    const files = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const vfs = await root.getDirectoryHandle(".nooklet-opfs-sahpool");
        const opaque = await vfs.getDirectoryHandle(".opaque");
        let n = 0;
        // biome-ignore lint/suspicious/noExplicitAny: FileSystemDirectoryHandle iteration is not in lib.dom here.
        for await (const _ of (opaque as any).values()) n++;
        return n;
      } catch {
        return -1;
      }
    });
    if (files >= 0 && files < 6) short++;
    const t0 = Date.now();
    await page.goto(pagePath(name));
    const outliner = page.locator(".vr-outliner").first();
    const loaded = await expect(outliner)
      .toContainText("seeded", { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!loaded) dead++;
    const indicator = (await page.locator(".app-sync-indicator").textContent()) ?? "";
    console.log(
      JSON.stringify({
        delay,
        filesAfterInterrupt: files,
        loaded,
        nextStartMs: Date.now() - t0,
        indicator,
        errors,
      }),
    );
    await ctx.close();
  }
  console.log(JSON.stringify({ shortPools: short, dead, of: DELAYS.length }));
  expect(dead).toBe(0);
});
