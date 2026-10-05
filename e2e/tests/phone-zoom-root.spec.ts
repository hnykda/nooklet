/**
 * B-788 where the owner hit it: on the phone (an iPhone 13's viewport, touch, coarse pointer),
 * zoomed into a block with no children, typed into it and pressed Return — and nothing appeared;
 * the new blocks were outside the zoomed view. Runs in Chromium and WebKit; the desktop half is
 * `zoom-root.spec.ts`.
 *
 * Return is pressed both ways a phone sends it: a hardware Enter, and the soft keyboard's
 * Shift+Enter with the keyboard up (`kb-open`), which is what iOS sends at the start of a sentence
 * (`phone-input.spec.ts`, B-662).
 */

import { devices, expect, type Page, test } from "@playwright/test";
import {
  caret,
  editor,
  openPage,
  readBlocks,
  rowDepths,
  rowTexts,
  runName,
} from "../helpers/index.js";
import { charBox, fontSize } from "../helpers/text-geometry.js";

test.use({ ...devices["iPhone 13"] });

/** `base` made unique per project, repeat and retry: both engines run this file against one
 * server, and a page the other engine already typed into would start with its keystrokes. */
function unique(base: string): string {
  const info = test.info();
  return `${runName(base, info)} ${info.project.name}`;
}

const toolbarButton = (page: Page, command: string) =>
  page.locator(`.cmd-toolbar button[aria-label='${command}']`);

async function zoomedLeaf(page: Page, name: string) {
  const outliner = await openPage(page, name, "- before\n- leaf\n- after");
  await outliner.locator(".vr-row").nth(1).getByRole("button", { name: "Zoom into block" }).tap();
  await expect(page.locator(".vr-zoom-trail")).toBeVisible();
  const zoomed = page.locator(".vr-outliner").first();
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["leaf"]);
  await zoomed.locator(".vr-row").first().locator(".vr-block-view").tap();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  return zoomed;
}

for (const [how, key, softKeyboard] of [
  ["hardware Enter", "Enter", false],
  ["soft keyboard Return", "Shift+Enter", true],
] as const) {
  test(`B-788: phone, zoomed into a leaf, ${how} makes a visible child that takes the typing`, async ({
    page,
  }) => {
    const name = unique(`Phone Zoom Root ${softKeyboard ? "Soft" : "Hard"}`);
    const zoomed = await zoomedLeaf(page, name);
    if (softKeyboard) {
      await page.evaluate(() => document.documentElement.classList.add("kb-open"));
    }
    await page.keyboard.type(" typed");
    await page.keyboard.press(key);
    await expect.poll(() => rowTexts(page, zoomed)).toEqual(["leaf typed", ""]);
    expect(await rowDepths(page, zoomed)).toEqual([0, 1]);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("child");
    await expect(editor(page)).toHaveText("child");
    await expect
      .poll(async () => (await readBlocks(page, name)).map((b) => [b.content, b.depth]))
      .toEqual([
        ["before", 0],
        ["leaf typed", 0],
        ["child", 1],
        ["after", 0],
      ]);
  });
}

test("B-788: phone, the toolbar's outdent cannot take a child out of the zoomed view", async ({
  page,
}) => {
  const name = unique("Phone Zoom Root Outdent");
  const zoomed = await zoomedLeaf(page, name);
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await expect.poll(() => rowTexts(page, zoomed)).toEqual(["leaf", "child"]);
  await toolbarButton(page, "block.outdent").tap();
  await expect(editor(page)).toBeFocused();
  await page.waitForTimeout(700);
  expect(await rowTexts(page, zoomed)).toEqual(["leaf", "child"]);
  expect(await rowDepths(page, zoomed)).toEqual([0, 1]);
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => [b.content, b.depth]))
    .toEqual([
      ["before", 0],
      ["leaf", 0],
      ["child", 1],
      ["after", 0],
    ]);
});

test("B-821: phone, the zoom root is the view's title, and a tap at its end puts the caret there", async ({
  page,
}) => {
  const text = "Plan the garden beds";
  const name = unique("Phone Zoom Root Title");
  const outliner = await openPage(page, name, `- before\n- ${text}\n  - kid\n- after`);
  const body = await fontSize(outliner.locator(".vr-row").first().locator(".vr-block-view"));
  await outliner.locator(".vr-row").nth(1).getByRole("button", { name: "Zoom into block" }).tap();
  await expect(page.locator(".vr-zoom-trail")).toBeVisible();
  const zoomed = page.locator(".vr-outliner").first();
  const root = zoomed.locator(".vr-row").first();
  expect(await fontSize(root.locator(".vr-block-view"))).toBeGreaterThanOrEqual(body * 1.2);
  expect(await fontSize(zoomed.locator(".vr-row").nth(1).locator(".vr-block-view"))).toBe(body);

  // A tap just past the last character: caret at the end, and the text did not move.
  const drawn = await charBox(root, -1);
  await page.touchscreen.tap(drawn.right + 3, (drawn.top + drawn.bottom) / 2);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => caret(page)).toEqual({ anchor: text.length, head: text.length });
  const editing = await charBox(root, -1);
  expect(Math.abs(editing.left - drawn.left)).toBeLessThan(1.5);
  expect(Math.abs(editing.top - drawn.top)).toBeLessThan(1.5);
  await page.keyboard.type(" now");
  await expect(editor(page)).toHaveText(`${text} now`);
  await expect.poll(async () => (await readBlocks(page, name))[1]?.content).toBe(`${text} now`);
});
