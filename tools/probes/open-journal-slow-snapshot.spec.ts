/**
 * Probe (2026-09-13, m10/tests-desktop, B-335): does `e2e/helpers/editor.ts#openJournal` still hand
 * back today's outliner when the fresh client's first snapshot is slow — the window in which the
 * journal stream draws today as a virtual draft even though today exists on the server?
 *
 * The old helper filled that draft and then blurred it; when the snapshot landed in between, the
 * stream swapped the draft for the real outliner (B-243 appends the typed "seed" to the day) and
 * `blur()` waited out the 30 s test timeout for a textarea that no longer existed. Seen 3 times in
 * 24 runs of editing.spec's first three tests under 56 busy node loops (load average ≈ 65), page
 * snapshot showing "seed" as a new last row of an existing today.
 *
 * Here the snapshot is held for `HOLD_MS` so the draft is certainly on screen when the helper runs;
 * the helper must return today's outliner, and no virtual draft may have been committed (no
 * "seed" row added by a draft when today already had blocks). Prints and asserts. To re-run, copy
 * it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium --repeat-each=5
 * then delete the copy.
 */
import { expect, test } from "@playwright/test";
import { api, isoOffset, openJournal, readBlocks } from "../helpers/index.js";

const HOLD_MS = 3_000;

test("probe: openJournal with a slow first snapshot", async ({ page }) => {
  const today = isoOffset(0);
  // Today exists on the server before the client starts, as it does in any full run.
  if ((await readBlocks(page, today).catch(() => [])).length === 0) {
    await api(page, "page.append", { page: today, markdown: "- made real before the probe" });
  }
  const before = (await readBlocks(page, today)).length;

  let draftSeen = false;
  await page.route("**/sync/snapshot", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });
  page.on("framenavigated", () => {
    void page
      .locator(".journal-day-today .vr-draft-input")
      .waitFor({ timeout: HOLD_MS })
      .then(() => {
        draftSeen = true;
      })
      .catch(() => {});
  });

  const t0 = Date.now();
  const outliner = await openJournal(page);
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  const after = (await readBlocks(page, today)).length;
  console.log(JSON.stringify({ draftSeen, ms: Date.now() - t0, before, after }));
  expect(after).toBe(before);
});
