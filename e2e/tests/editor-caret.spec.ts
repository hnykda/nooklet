/**
 * B-745: in dark mode the block editor's caret was black on a near-black page. The caret is the
 * browser's own (no `drawSelection()`), coloured by `caret-color`, which CodeMirror's base theme
 * pins to black. Checked as the computed colour, in both ways of getting dark mode.
 */

import { expect, type Page, test } from "@playwright/test";
import { editor, openEditing } from "../helpers/index.js";

async function caretAndText(page: Page): Promise<{ caret: string; fg: string; bg: string }> {
  return editor(page).evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fg)";
    document.body.append(probe);
    const fg = getComputedStyle(probe).color;
    probe.remove();
    return {
      caret: getComputedStyle(el).caretColor,
      fg,
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });
}

test("B-745: the caret is the text colour in dark mode chosen in Settings", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nooklet.theme", "dark"));
  await openEditing(page, "Caret Dark Setting", "- start");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const c = await caretAndText(page);
  expect(c.caret).toBe(c.fg);
  expect(c.caret).not.toBe("rgb(0, 0, 0)");
});

test.describe("with the system in dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("B-745: the caret is the text colour", async ({ page }) => {
    await openEditing(page, "Caret Dark System", "- start");
    const c = await caretAndText(page);
    expect(c.caret).toBe(c.fg);
    expect(c.caret).not.toBe(c.bg);
    expect(c.caret).not.toBe("rgb(0, 0, 0)");
  });
});
