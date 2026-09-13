/**
 * Probe (2026-09-13, impl-dates, B-142): does Cmd/Ctrl+Z undo a date set through the date picker?
 *
 * Answer when written: NO. After `/scheduled` + `tomorrow` + Enter, then Cmd+Z and 1.5 s, the
 * server still had `scheduled: <tomorrow>`. The picker writes through the command `Store`
 * (`applyOp`), which never reaches `BlockTree`'s `EditHistory`.
 *
 * Not part of the suite (it asserts nothing about the answer, it prints it). To re-run, copy it
 * into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/picked-date-undo.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, MOD, openEditing } from "../helpers/index.js";

async function scheduledOf(page: Page, name: string): Promise<string | undefined> {
  const out = await api<{ tree: Array<{ properties?: Record<string, string> }> }>(
    page,
    "page.read",
    { page: name, format: "json" },
  );
  return out.tree[0]?.properties?.scheduled;
}

test("probe: is a picked date undoable?", async ({ page }) => {
  await openEditing(page, "Probe Undo Date", "- TODO thing");
  await page.keyboard.type(" /sched");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("tomorrow");
  await page.keyboard.press("Enter");
  await expect.poll(() => scheduledOf(page, "Probe Undo Date")).toBeTruthy();
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(1500);
  console.log("scheduled after Cmd+Z:", await scheduledOf(page, "Probe Undo Date"));
});
