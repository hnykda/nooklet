/**
 * Probe (2026-09-13, m11/keys-in-fields, B-300): with a block selection standing — or an edit open
 * behind the palette — which keys typed into a text field OUTSIDE the outliner still act on the
 * outliner through the global keymap?
 *
 * Prints one `PROBE` line per case and asserts nothing about the answer. Not part of the suite. To
 * re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/keys-in-fields-selection.spec.ts --project=chromium
 * then delete the copy.
 *
 * Answer at `52e5d20` (Chromium, macOS, run once), one block of three selected with Escape:
 * - title, text selected, Backspace / Meta+X: title emptied, blocks untouched — B-347's key list
 *   (`app/text-field-keys.ts`) had already fixed the case B-300 was first reported for.
 * - title Enter: `selected=0 editing=1`, focus in the block editor (block.editSelected ran).
 * - title Tab: nothing visible (block.indentSelected on the first block, which cannot indent).
 * - title Escape: `selected=0` (block.clearSelection ran), title keeps focus.
 * - title Meta+Shift+D: stored `["pk one","pk one","pk two","pk three"]` — duplicated on the server.
 * - title Meta+Enter: nothing visible within 700 ms.
 * - title Meta+.: rows `[0]` — zoomed into the selected block.
 * - title Alt+ArrowUp: nothing (arrows are on B-347's list).
 * - palette Backspace: input `ab`, blocks untouched. Meta+A: input `abc`, blocks untouched.
 * - palette Meta+Shift+D: block duplicated, editing opened behind the palette. Meta+.: zoomed.
 * - palette over an open edit, Meta+Shift+K: stored `"pk one[]()"` — format.insertLink wrote into
 *   the block behind the palette. Meta+B / Meta+E: nothing stored within 700 ms.
 * After the fix (dispatch with the outliner hidden from such a field), same run: every title and
 * palette case above leaves stored blocks, depths and the selection untouched; title Enter and
 * Meta+Enter commit the title (focus to body), Tab moves focus natively, Escape leaves the
 * selection standing. Asserted by `e2e/tests/keys-in-fields.spec.ts`.
 *
 * Buttons (added after the fix; a button is not a field, so unchanged by it), `.help-fab` focused:
 * Enter → `selected=0 editing=1`, help menu NOT opened (block.editSelected took the key); Space →
 * help menu opened, selection kept; Backspace → the selected block deleted on the server. Logged
 * as B-450.
 */
import { expect, type Page, test } from "@playwright/test";
import { MOD, openEditing, readBlocks, rowDepths } from "../helpers/index.js";

const SEED = "- pk one\n- pk two\n- pk three";

async function state(page: Page, name: string): Promise<string> {
  await page.waitForTimeout(700);
  const outliner = page.locator(".vr-outliner").first();
  const stored = (await readBlocks(page, name).catch(() => [])).map((b) => b.content);
  const depths = await rowDepths(page, outliner).catch(() => []);
  const selected = await outliner.locator(".vr-row-selected").count();
  const editing = await page.locator(".vr-outliner .cm-content").count();
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}.${el.className}` : "none";
  });
  const title = await page
    .locator("textarea.page-title-input")
    .inputValue()
    .catch(() => "-");
  return `stored=${JSON.stringify(stored)} depths=${JSON.stringify(depths)} selected=${selected} editing=${editing} active=${active} title=${JSON.stringify(title)} url=${new URL(page.url()).pathname}`;
}

const TITLE_KEYS = [
  "Backspace",
  `${MOD}+x`,
  "Enter",
  "Tab",
  "Escape",
  `${MOD}+Shift+d`,
  `${MOD}+Enter`,
  `${MOD}+.`,
  "Alt+ArrowUp",
];

for (const [i, key] of TITLE_KEYS.entries()) {
  test(`probe: ${key} in the page title with one block selected`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const name = `Probe Title Key ${i}`;
    const outliner = await openEditing(page, name, SEED);
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    await page.keyboard.press("Escape");
    await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
    const title = page.locator("textarea.page-title-input");
    await title.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press(key);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log(`PROBE title ${key}: ${await state(page, name)} clip=${JSON.stringify(clip)}`);
  });
}

const PALETTE_KEYS = ["Backspace", `${MOD}+a`, `${MOD}+x`, `${MOD}+Shift+d`, `${MOD}+.`];

for (const [i, key] of PALETTE_KEYS.entries()) {
  test(`probe: ${key} in the palette with one block selected`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const name = `Probe Palette Key ${i}`;
    const outliner = await openEditing(page, name, SEED);
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    await page.keyboard.press("Escape");
    await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
    await page.mouse.move(4, 700);
    await page.keyboard.press(`${MOD}+k`);
    const input = page.locator(".cmd-palette .cmd-input");
    await expect(input).toBeVisible();
    await page.keyboard.type("abc");
    await page.keyboard.press(key);
    const value = await input.inputValue().catch(() => "(closed)");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log(
      `PROBE palette ${key}: input=${JSON.stringify(value)} ${await state(page, name)} clip=${JSON.stringify(clip)}`,
    );
  });
}

const PALETTE_EDITING_KEYS = [`${MOD}+b`, `${MOD}+e`, `${MOD}+Shift+k`];

for (const [i, key] of PALETTE_EDITING_KEYS.entries()) {
  test(`probe: ${key} in the palette over an open edit`, async ({ page }) => {
    const name = `Probe Palette Edit Key ${i}`;
    await openEditing(page, name, SEED);
    await page.mouse.move(4, 700);
    await page.keyboard.press(`${MOD}+k`);
    const input = page.locator(".cmd-palette .cmd-input");
    await expect(input).toBeVisible();
    await page.keyboard.type("abc");
    await page.keyboard.press(key);
    const value = await input.inputValue().catch(() => "(closed)");
    console.log(
      `PROBE palette-over-edit ${key}: input=${JSON.stringify(value)} ${await state(page, name)}`,
    );
  });
}

// A button is not a field (B-300's fix leaves it out): what do Enter and Space on a focused button
// outside the outliner do while a block selection stands?
for (const [i, key] of ["Enter", " ", "Backspace"].entries()) {
  test(`probe: ${JSON.stringify(key)} on a focused button with one block selected`, async ({
    page,
  }) => {
    const name = `Probe Button Key ${i}`;
    const outliner = await openEditing(page, name, SEED);
    await page.keyboard.press("Escape");
    await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
    const help = page.locator(".help-fab");
    await help.focus();
    await page.keyboard.press(key === " " ? "Space" : key);
    const menuOpen = await page.getByRole("button", { name: "Settings" }).count();
    console.log(
      `PROBE button ${JSON.stringify(key)}: helpMenuOpen=${menuOpen > 0} ${await state(page, name)}`,
    );
  });
}
