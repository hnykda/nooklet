/**
 * Probe (2026-10-04, B-651): does a TAP on the task marker fire `click` in Playwright's touch
 * emulation? Logs every pointer/touch/click event at the window (bubble phase, so
 * `defaultPrevented` shows what the app did) for a tap on the Properties toggle (no pointerdown
 * handler) and then on the marker (`onPointerDown` preventDefault).
 *
 * Result in Chromium: Properties got `click`; the marker got pointerdown (prevented), touchstart,
 * pointerup, touchend and NO click. Not part of the suite (it prints; it does not assert). To
 * re-run, copy it into `e2e/tests/` and:
 *   NOOKLET_E2E_PORT=<your port> pnpm e2e <copy> --project chromium --reporter=line
 * then delete the copy.
 */
import { devices, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });
test("probe tap on marker", async ({ page }) => {
  const outliner = await openPage(page, "Probe Tap", "- TODO buy milk");
  await page.evaluate(() => {
    const w = window as unknown as { __ev: string[] };
    w.__ev = [];
    for (const t of ["pointerdown", "pointerup", "touchstart", "touchend", "click", "focusin"])
      window.addEventListener(
        t,
        (e) =>
          w.__ev.push(
            `${t}:${(e.target as Element).tagName}.${(e.target as Element).getAttribute?.("class") ?? ""} prevented=${e.defaultPrevented}`,
          ),
        false,
      );
  });
  const box = outliner.locator(".vr-marker");
  await page.getByRole("button", { name: /Properties/ }).tap();
  await page.waitForTimeout(500);
  await box.tap();
  await page.waitForTimeout(1000);
  console.log(await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev.join("\n")));
  console.log(await outliner.locator(".vr-row").first().innerHTML());
});
