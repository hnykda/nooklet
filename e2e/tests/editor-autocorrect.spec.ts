/**
 * B-742: the block editor asks for autocorrect only on touch devices. On a Mac, WebKit (the
 * desktop shell, Safari) shows an iOS-style suggestion bubble for `autocorrect="on"`; Chromium
 * ignores the attribute, so what is checked here is the attribute itself, in both projects.
 */

import { devices, expect, test } from "@playwright/test";
import { editor, openEditing } from "../helpers/index.js";

test.describe("with a mouse", () => {
  test("B-742: no autocorrect or writing suggestions in the block editor", async ({ page }) => {
    await openEditing(page, "Autocorrect Desktop", "- start");
    await expect(editor(page)).toHaveAttribute("autocorrect", "off");
    await expect(editor(page)).toHaveAttribute("writingsuggestions", "false");
    await expect(editor(page)).toHaveAttribute("spellcheck", "true");
  });
});

// `defaultBrowserType` cannot be set inside a describe; the project picks the browser.
const { defaultBrowserType: _browser, ...iPhone } = devices["iPhone 13"];

test.describe("on a phone", () => {
  test.use(iPhone);

  test("B-742: autocorrect stays on for typing on glass", async ({ page }) => {
    await openEditing(page, "Autocorrect Phone", "- start");
    await expect(editor(page)).toHaveAttribute("autocorrect", "on");
  });
});
