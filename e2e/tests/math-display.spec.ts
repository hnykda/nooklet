/**
 * B-264: `$$…$$` is Logseq's display math, and the owner's graph uses it. It rendered as a stray
 * `$`, an inline formula, and another `$`.
 */
import { expect, test } from "@playwright/test";
import { clickAway, editor, openEditing, openPage } from "../helpers/index.js";

test("$$…$$ renders as display math with no stray dollar signs (B-264)", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Math Display View",
    "- Display math $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$ end\n- *je to $$CO_2$$*\n- inline $e^{i\\pi}+1=0$ stays inline",
  );
  const rows = outliner.locator(".vr-row");
  const first = rows.nth(0);
  await expect(first.locator(".katex-display")).toHaveCount(1);
  await expect(first.locator(".vr-math")).toHaveCount(1);
  await expect(first.locator(".vr-block-view")).not.toContainText("$");
  await expect(first.locator(".vr-block-view")).toContainText("Display math");
  await expect(first.locator(".vr-block-view")).toContainText("end");

  await expect(rows.nth(1).locator(".katex-display")).toHaveCount(1);
  await expect(rows.nth(1).locator(".vr-block-view")).not.toContainText("$");

  await expect(rows.nth(2).locator(".katex")).toHaveCount(1);
  await expect(rows.nth(2).locator(".katex-display")).toHaveCount(0);
});

test("inside the editor, display math is a widget until the caret touches it (B-264)", async ({
  page,
}) => {
  await openEditing(page, "Math Display Edit", "- $$x^2$$ and words");
  await expect(editor(page).locator(".katex-display")).toBeVisible();
  await expect(editor(page)).not.toContainText("$");

  await page.keyboard.press("Home");
  await expect(editor(page).locator(".katex")).toHaveCount(0);
  await expect(editor(page)).toContainText("$$x^2$$");

  await clickAway(page);
});
