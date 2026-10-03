/**
 * A phone: Playwright's iPhone 13 descriptor (390 px viewport, touch, coarse pointer, no hover,
 * iPhone user agent, WebKit — the descriptor's own browser). The sidebar becomes a
 * drawer over the content, the editor has to stay typeable, and the keyboard toolbar (spec R60)
 * is the only way to indent, outdent, or open `[[` without a hardware keyboard.
 *
 * `detectPlatformFromEnvironment` decides `mobile` from the user agent and
 * `(pointer: coarse) and not (hover: hover)` — never from the viewport width — which is exactly
 * what the descriptor emulates.
 */

import { devices, expect, test } from "@playwright/test";
import { clickRow, editor, openEditing, openPage, rowDepths, rowTexts } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

test("the sidebar is a drawer over the content and closes again", async ({ page }) => {
  await page.goto("/journals");
  await page.locator("button[aria-label='Toggle sidebar']").click();
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar).toBeVisible();
  const box = await sidebar.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width ?? 0).toBeLessThan(390);
  expect(await sidebar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await sidebar.locator(".sidebar-nav a[href$='/pages']").click();
  await expect(page).toHaveURL(/\/pages$/);
  // The open drawer covers the toggle button, so close it with the command's key. The app
  // resolves `Mod` from the (iPhone) user agent, so this is Cmd whatever the host OS.
  await page.keyboard.press("Meta+\\");
  await expect(sidebar).toHaveCount(0);
});

test("the page does not scroll sideways at phone width", async ({ page }) => {
  await openPage(
    page,
    "Phone No Overflow",
    "- a fairly long line of text that has to wrap rather than push the page wider than the screen\n  - nested child with more words in it",
  );
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.querySelector(".page-scroll")?.scrollWidth ?? 0,
    clientWidth: document.querySelector(".page-scroll")?.clientWidth ?? 0,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("tapping a block opens the editor and typing lands", async ({ page }) => {
  const outliner = await openEditing(page, "Phone Typeable", "- start");
  await page.keyboard.type(" on a phone");
  await expect(editor(page)).toHaveText("start on a phone");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["start on a phone", "second"]);
});

// B-70 was checked under the plain `devices["iPhone 13"]` descriptor (WebKit, iPhone user agent,
// `pointer: coarse`, no hover, the editor focused): `.cmd-toolbar` count stayed 0.
test("the keyboard toolbar appears while editing", async ({ page }) => {
  await openEditing(page, "Phone Toolbar Shows", "- start");
  const toolbar = page.locator(".cmd-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator(".cmd-toolbar-button")).toHaveCount(12);
});

test("the toolbar's indent, outdent, [[ and undo buttons run their commands", async ({ page }) => {
  const outliner = await openEditing(page, "Phone Toolbar Buttons", "- first\n- second");
  await clickRow(page, outliner, 1);
  const toolbar = page.locator(".cmd-toolbar");
  await expect(toolbar).toBeVisible();

  await toolbar.locator("button[aria-label='block.indent']").click();
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);
  await expect(editor(page)).toBeFocused();
  await toolbar.locator("button[aria-label='block.outdent']").click();
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0]);

  await toolbar.locator("button[aria-label='format.insertPageRef']").click();
  await expect(editor(page)).toHaveText("second[[");
  await expect(page.locator(".cmd-popup")).toBeVisible();

  await toolbar.locator("button[aria-label='edit.undo']").click();
  await expect(editor(page)).toHaveText("second");
});

// B-565: the settings panel is tall enough (Appearance/Search/Templates/Plugins/About) to exceed
// an iPhone 13's 844px viewport height; `.set-backdrop` (not `.set-panel`) is the scroll container,
// so scrolling into the panel's content used to carry the header — and its only close button —
// off-screen with it, with no sticky header to keep it reachable.
test("the settings panel's close button stays reachable after scrolling on a phone screen", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const panel = page.locator(".set-panel");
  await expect(panel).toBeVisible();

  await page.locator(".set-backdrop").evaluate((el) => el.scrollBy(0, 700));
  const close = page.getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(panel).toHaveCount(0);
});
