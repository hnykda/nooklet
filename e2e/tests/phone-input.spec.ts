/**
 * Phone input fixes (2026-10-04), at an iPhone 13's viewport with touch and a coarse pointer:
 * B-662 (Return in an empty day's draft), B-664 (the toolbar after "hide keyboard"), B-661 (a TAP
 * on the task marker, the bullet and the toolbar buttons). B-699 is a pairing-link screen, which
 * only a deep link opens; it is covered by `PairingLinkPrompt.test.tsx` and the Simulator.
 *
 * Runs in both projects (Chromium and WebKit). Taps are real touch taps (`tap()`, `hasTouch`),
 * not clicks. What neither engine can show — iOS's soft keyboard and its Return — was checked on
 * the Simulator (`tools/probes/phone-input/`).
 */

import { devices, expect, type Page, test } from "@playwright/test";
import {
  editor,
  isoOffset,
  openEditing,
  openPage,
  pagePath,
  rowDepths,
  rowTexts,
} from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

const toolbar = (page: Page) => page.locator(".cmd-toolbar");
const toolbarButton = (page: Page, command: string) =>
  page.locator(`.cmd-toolbar button[aria-label='${command}']`);

/** A day nobody has written, different on each run: its first line is the draft textarea. */
async function openEmptyDay(page: Page, salt: number) {
  const day = isoOffset(-(11000 + salt * 1000 + (Date.now() % 900)));
  await page.goto(pagePath(day));
  const draft = page.locator(".page-view-draft .vr-draft-input");
  await expect(draft).toBeVisible();
  return draft;
}

test("B-662: a line break arriving as `beforeinput` (iOS Return) starts the day, not a newline", async ({
  page,
}) => {
  const draft = await openEmptyDay(page, 1);
  await draft.tap();
  await page.keyboard.type("ab");
  // What iOS's soft keyboard delivers for Return, after a keydown the draft could not stop
  // (Simulator log): `beforeinput insertLineBreak`. If nothing cancels it, apply the browser's
  // default — the newline the bug left in the draft.
  const prevented = await draft.evaluate((el: HTMLTextAreaElement) => {
    const e = new InputEvent("beforeinput", {
      inputType: "insertLineBreak",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(e);
    if (!e.defaultPrevented) {
      el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak", bubbles: true }));
    }
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  // The line is a block and the caret is in the next, empty one — as Return in the outliner.
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("");
  const outliner = page.locator(".page-view .vr-outliner").first();
  expect(await rowTexts(page, outliner)).toEqual(["ab", ""]);
  await page.keyboard.type("cd");
  await expect(editor(page)).toHaveText("cd");
});

test("B-662: a hardware Enter in the draft still makes exactly one new block; Shift+Enter stays a line break", async ({
  page,
}) => {
  const draft = await openEmptyDay(page, 2);
  await draft.tap();
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("");
  const outliner = page.locator(".page-view .vr-outliner").first();
  // Two rows, not three: keydown and `beforeinput` must not both count the one Enter.
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  // And Shift+Enter's line break stayed inside the first block.
  expect(await outliner.locator(".vr-row").first().innerText()).toMatch(/^one\n+two$/);
});

/**
 * What iOS's soft keyboard sends for Return at the start of a sentence (and, on the Simulator,
 * whenever its shift is lit): Shift+Enter (`tools/probes/phone-input/`, `keydown "Enter" 13
 * shift=true`). The iPhone 13 descriptor's user agent is iOS; `kb-open` is what the keyboard inset
 * watcher sets while the soft keyboard is up.
 */
async function softKeyboardUp(page: Page) {
  await page.evaluate(() => document.documentElement.classList.add("kb-open"));
}

test("B-662: the iOS soft keyboard's Return (auto-capitalisation Shift) starts a block from the draft", async ({
  page,
}) => {
  const draft = await openEmptyDay(page, 3);
  await draft.tap();
  await page.keyboard.type("ab");
  await softKeyboardUp(page);
  await page.keyboard.press("Shift+Enter");
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("");
  const outliner = page.locator(".page-view .vr-outliner").first();
  expect(await rowTexts(page, outliner)).toEqual(["ab", ""]);
});

test("B-662: the iOS soft keyboard's Return (auto-capitalisation Shift) splits a block", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Phone Soft Return", "- first");
  await softKeyboardUp(page);
  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["first", ""]);
  await page.keyboard.type("second");
  await expect(editor(page)).toHaveText("second");
});

test("B-664: the toolbar's hide-keyboard button ends editing and hides the toolbar; it comes back unscrolled", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Phone Hide Keyboard", "- first\n- second");
  await expect(toolbar(page)).toBeVisible();
  const hide = toolbarButton(page, "app.hideKeyboard");
  // The last button: reaching it scrolls the toolbar sideways, as a thumb does on a phone.
  await hide.scrollIntoViewIfNeeded();
  expect(await toolbar(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await hide.tap();

  await expect(toolbar(page)).toHaveCount(0);
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  expect(await rowTexts(page, outliner)).toEqual(["first", "second"]);

  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").tap();
  await expect(editor(page)).toBeFocused();
  await expect(toolbar(page)).toBeVisible();
  expect(await toolbar(page).evaluate((el) => el.scrollLeft)).toBe(0);
});

test("B-661: a tap on the task marker ticks it", async ({ page }) => {
  const outliner = await openPage(page, "Phone Marker Tap", "- TODO buy milk");
  await outliner.getByRole("checkbox", { name: "Task: TODO" }).tap();
  await expect(outliner.getByRole("checkbox", { name: "Task: DONE" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // A tap toggles the marker; it does not start editing the block.
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  expect(await rowTexts(page, outliner)).toEqual(["buy milk"]);
});

test("B-661: tapping another block's marker while editing keeps the editor's focus", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Phone Marker Tap Editing", "- TODO first\n- second");
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").tap();
  await expect(editor(page)).toHaveText("second");
  await outliner.getByRole("checkbox", { name: "Task: TODO" }).tap();
  await expect(outliner.getByRole("checkbox", { name: "Task: DONE" })).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("second");
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("second!");
});

test("B-661: toolbar buttons work on a tap and keep the editor's focus", async ({ page }) => {
  const outliner = await openEditing(page, "Phone Toolbar Tap", "- first\n- second");
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").tap();
  await expect(editor(page)).toHaveText("second");
  await toolbarButton(page, "block.indent").tap();
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);
  await expect(editor(page)).toBeFocused();
  await toolbarButton(page, "task.cycle").tap();
  await expect(outliner.locator(".vr-marker")).toHaveCount(1);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("second!");
});

test("B-661: a tap on a bullet zooms in, a tap on the collapse arrow collapses", async ({
  page,
}) => {
  const outliner = await openPage(page, "Phone Bullet Tap", "- parent\n  - child\n- other");
  await outliner.locator(".vr-row").first().hover();
  await outliner.getByRole("button", { name: "Collapse block" }).first().tap();
  await expect(outliner.getByRole("button", { name: "Expand block" })).toBeVisible();
  expect(await rowTexts(page, outliner)).toEqual(["parent", "other"]);
  await outliner.getByRole("button", { name: "Expand block" }).tap();
  expect(await rowTexts(page, outliner)).toEqual(["parent", "child", "other"]);

  await outliner.getByRole("button", { name: "Zoom into block" }).first().tap();
  await expect
    .poll(() => rowTexts(page, page.locator(".vr-outliner").first()))
    .toEqual(["parent", "child"]); // the zoomed-in block and its children; "other" is out of view
});
