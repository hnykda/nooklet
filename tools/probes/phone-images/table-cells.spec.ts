/**
 * Probe (2026-10-04, found in the B-683 overflow sweep): what does a rendered table's cell hold?
 *
 * Result in Chromium: for content `| a | b |\n|---|---|\n| 1 | 2 |` (stored exactly so, read back
 * through the API) every cell renders `<span data-from="0" data-to="1">|</span>` — the text "|"
 * with offsets 0..1, not "a", "b", "1", "2". Tables with leading pipes show only bars. The unit
 * test (`tokens.test.tsx` "table -> …") checks the structure and alignment, not the cell text,
 * and uses the no-leading-pipe form `a|b`. Not part of the suite (it prints; it does not assert).
 * To re-run, copy it into `e2e/tests/` and:
 *   NOOKLET_E2E_PORT=<your port> pnpm e2e <copy> --project chromium --reporter=line
 * then delete the copy.
 */
import { test } from "@playwright/test";
import { openPage, readBlocks } from "../helpers/index.js";

test("probe: table cells", async ({ page }) => {
  await openPage(page, "Table Probe A", "- | a | b |\n  |---|---|\n  | 1 | 2 |");
  console.log("A", await page.locator(".vr-table").first().innerText());
  console.log("A content", JSON.stringify(await readBlocks(page, "Table Probe A")));
  console.log(
    "A html",
    await page
      .locator(".vr-table")
      .first()
      .evaluate((e) => e.outerHTML),
  );
  await openPage(
    page,
    "Table Probe B",
    "- | a | b | c |\n  |---|---|---|\n  | wide cell text | more | c |",
  );
  console.log("B", await page.locator(".vr-table").first().innerText());
  await openPage(page, "Table Probe C", "- intro\n- | a | b |\n  |---|---|\n  | 1 | 2 |\n- after");
  console.log("C", await page.locator(".vr-table").first().innerText());
});
