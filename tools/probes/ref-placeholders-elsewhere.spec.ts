/**
 * Probe (2026-09-13, ref-label-flash): besides the references panel (B-510), where else does a
 * `((block ref))` show as its raw `((id))`? Prints; does not assert. Settled B-512 in
 * docs/bugs-inbox/ref-label-flash.md — on `52ac1a6` the tasks view, a property value and a search
 * hit all print the `((id))`.
 *
 * To re-run, copy it into `e2e/tests/` and:
 *   NOOKLET_E2E_PORT=<your port> pnpm exec playwright test <copy> --project=chromium
 * (from `e2e/`), then delete the copy.
 */
import { expect, test } from "@playwright/test";
import { pagePath, readBlocks, seedPage } from "../helpers/index.js";

test("probe: tasks view, property value, search hit", async ({ page }) => {
  await seedPage(page, "Tmp Ref Target", "- tmp target text");
  const [t] = await readBlocks(page, "Tmp Ref Target");
  await seedPage(
    page,
    "Tmp Ref Host",
    `- TODO wombatprobe task quoting ((${t?.id}))\n- with prop\n  source:: ((${t?.id}))`,
  );
  await page.goto("/tasks");
  await expect(page.locator("body", { hasText: "wombatprobe" })).toBeVisible();
  await page.waitForTimeout(1500);
  const tasksText = await page.evaluate(
    () =>
      [...document.querySelectorAll("*")]
        .filter((e) => e.children.length === 0 && (e.textContent ?? "").includes("wombatprobe"))
        .map((e) => e.parentElement?.textContent)[0],
  );
  await page.goto(pagePath("Tmp Ref Host"));
  await expect(page.locator(".vr-prop").first()).toBeVisible();
  await page.waitForTimeout(1500);
  const propText = await page.locator(".vr-prop").first().textContent();
  await page.goto("/search");
  await page.locator("input").first().fill("wombatprobe");
  await page.waitForTimeout(2500);
  const searchText = await page.locator("main").first().textContent();
  console.log(
    JSON.stringify({ tasksText, propText, searchText: searchText?.slice(-120) }, null, 1),
  );
});
