/**
 * Probe (2026-09-13, m9/focus, B-147): with the date picker open over a block being edited, where
 * does COMPOSED text go — an IME's marked text, or a dead-key accent composed in place?
 *
 * Playwright's `keyboard.insertText` sends `insertText` (no composition), which the picker now
 * takes. A real composition is emulated here through CDP: `Input.imeSetComposition` (marked text,
 * `insertCompositionText`) and then `Input.insertText` to commit it — the sequence Chromium's own
 * IME tests use. Prints the picker's query and the editor text after each step.
 *
 * Not part of the suite (it prints; it does not assert). To re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, test } from "@playwright/test";
import { editorText, openEditing } from "../helpers/index.js";

test("probe: composed text while the date picker is open", async ({ page }, info) => {
  const name = `Probe Picker Composition ${info.repeatEachIndex} ${Date.now()}`;
  await openEditing(page, name, "- compose");
  await page.keyboard.type(" /sched");
  await expect(page.locator(".cmd-popup .cmd-row--active").first()).toHaveText("Scheduled");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toBeVisible();

  const report = async (step: string) => {
    const query = await page
      .locator(".date-picker .dp-text")
      .textContent({ timeout: 200 })
      .catch(() => "(none)");
    const open = await page.locator(".date-picker").count();
    console.log(
      `${step}: picker open=${open} query=${JSON.stringify(query)} editor=${JSON.stringify(await editorText(page))}`,
    );
  };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ˇ", selectionStart: 1, selectionEnd: 1 });
  await report("after marked text ˇ");
  await cdp.send("Input.imeSetComposition", { text: "č", selectionStart: 1, selectionEnd: 1 });
  await report("after marked text č");
  await cdp.send("Input.insertText", { text: "č" });
  await report("after commit č");
  await page.keyboard.insertText("zítra");
  await report("after insertText zítra");
});
