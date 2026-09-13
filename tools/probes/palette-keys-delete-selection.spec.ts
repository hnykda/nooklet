/**
 * Probe (2026-09-13, qafix-m8-editor, B-347): with blocks selected, does Backspace or Delete typed
 * into the command palette's input delete the selected blocks?
 *
 * Answer when written: YES, both. Three blocks, two selected, Cmd/Ctrl+K, type `abc`, ArrowLeft,
 * then the key: output was `rows=1 input="abc" stored=["p three"]` for Backspace and for Delete —
 * the two selected blocks were gone on the server and the input was not edited. Found because
 * Playwright's `fill("")` on the palette input presses Delete.
 *
 * Not part of the suite (it prints the answer, asserts nothing about it). To re-run, copy it into
 * `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/palette-keys-delete-selection.spec.ts --project=chromium
 * then delete the copy.
 */
import { expect, test } from "@playwright/test";
import { MOD, openEditing, readBlocks } from "../helpers/index.js";

for (const key of ["Backspace", "Delete"]) {
  test(`probe: ${key} in the palette input with 2 blocks selected`, async ({ page }) => {
    const name = `Probe Palette ${key}`;
    const outliner = await openEditing(page, name, "- p one\n- p two\n- p three");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);
    await page.mouse.move(4, 700);
    await page.keyboard.press(`${MOD}+k`);
    const palette = page.locator(".cmd-palette").first();
    await expect(palette).toBeVisible();
    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    const rows = await outliner.locator(".vr-row").count();
    const input = await palette.locator(".cmd-input").inputValue();
    const stored = (await readBlocks(page, name)).map((b) => b.content);
    console.log(
      `PROBE ${key}: rows=${rows} input=${JSON.stringify(input)} stored=${JSON.stringify(stored)}`,
    );
  });
}
