/**
 * Probe (2026-10-04, e2e-flaky): after "Open plugin manager", where is Settings' Plugins section
 * over the next 1.5 s? `commands.spec.ts` "Open plugin manager…" (B-98) failed in a full run with
 * the section present but `viewport ratio 0`. Hypothesis: the section is scrolled into view the
 * moment it mounts, and the sections above it (templates, embeddings, devices) load their data
 * afterwards, grow, and push it out of view.
 *
 * Logs, every animation frame: the backdrop's (the scroller's) scrollTop/scrollHeight/clientHeight and
 * the section's top in the viewport. Not part of the suite (it prints; it does not assert). To re-run, copy it into
 * `e2e/tests/` and:
 *   NOOKLET_E2E_PORT=<your port> pnpm e2e <copy> --project chromium --reporter=line
 * then delete the copy.
 */
import { test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

test("probe plugins section scroll", async ({ page }) => {
  await openPage(page, "Probe Settings Scroll", "- here");
  await page.evaluate(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    const t0 = performance.now();
    const tick = () => {
      const panel = document.querySelector(".set-backdrop");
      const section = document.querySelector("#set-plugins");
      if (panel && section) {
        // Relative to the viewport: what `toBeInViewport` judges. The backdrop is the scroller.
        const top = section.getBoundingClientRect().top;
        const line = `${panel.scrollTop}/${panel.scrollHeight}/${panel.clientHeight} top=${Math.round(top)}`;
        if (w.__log.at(-1)?.endsWith(line) !== true)
          w.__log.push(`${Math.round(performance.now() - t0)}ms ${line}`);
      }
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // As `commands.spec.ts#runFromPalette` does it.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".cmd-palette .cmd-input");
  await input.fill(">");
  await input.fill("Open plugin manager");
  await page
    .locator(".cmd-palette .cmd-row")
    .filter({ has: page.locator("span:first-child", { hasText: /^Open plugin manager$/ }) })
    .click();
  await page.waitForTimeout(3000);
  console.log(
    (await page.evaluate(() => (window as unknown as { __log: string[] }).__log)).join("\n"),
  );
});
