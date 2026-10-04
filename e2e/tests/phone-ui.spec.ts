/**
 * Phone UI fixes from the owner's first real-device test (2026-10-04), at an iPhone 13's viewport
 * with touch and a coarse pointer: B-646 (`/` and the slash menu), B-648 (Properties widening the
 * page), B-649 (Back/Forward greyed out), B-650 (the graph switcher closes on an outside tap),
 * B-651 (cycling a task to DOING/NOW, and the checkbox drawn as an icon).
 *
 * Runs in both projects (Chromium and WebKit). What neither can show — the iOS soft keyboard's own
 * events, and iOS's zoom-on-focus — was checked on the Simulator (`tools/probes/phone-ui/`).
 */

import { devices, expect, test } from "@playwright/test";
import { editor, isoOffset, openEditing, openPage, pagePath, rowTexts } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

const popup = (page: import("@playwright/test").Page) => page.locator(".cmd-popup");

test("B-646: `/` typed into an empty day's first line opens the slash menu", async ({ page }) => {
  // A day nobody has written (a different one each run, as in `empty-journal-page.spec.ts`): its
  // first line is the draft textarea, not a block editor, whichever specs ran before this one.
  const day = isoOffset(-(7000 + (Date.now() % 3000)));
  await page.goto(pagePath(day));
  const draft = page.locator(".page-view-draft .vr-draft-input");
  await expect(draft).toBeVisible();
  await draft.click();
  await page.keyboard.type("ab /");
  // The day starts and the caret moves into the block editor, after the `/`.
  await expect(editor(page)).toHaveText("ab /");
  await expect(popup(page)).toBeVisible();
  // And the menu works from there: the query filters it, Escape leaves the text.
  await page.keyboard.type("todo");
  await expect(editor(page)).toHaveText("ab /todo");
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
});

test("B-646: text that arrives with no key events (`input` only) still opens the menu", async ({
  page,
}) => {
  await openEditing(page, "Phone Slash Input Only", "- start");
  // `insertText` fires `input` and no keydown/keyup — what a suggestion bar, dictation or an IME
  // commit delivers.
  await page.keyboard.insertText(" /");
  await expect(editor(page)).toHaveText("start /");
  await expect(popup(page)).toBeVisible();
});

test("B-646: the toolbar's `/` works mid-block, adding the space a `/` needs", async ({ page }) => {
  await openEditing(page, "Phone Slash Toolbar", "- start");
  const slash = page.locator(".cmd-toolbar button[aria-label='block.openSlashMenu']");
  await expect(slash).toBeEnabled();
  await slash.click();
  await expect(editor(page)).toHaveText("start /");
  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toHaveCount(1);
});

test("B-648: opening Properties keeps the page within the screen, fields at 16px", async ({
  page,
}) => {
  await openPage(page, "Phone Properties Width", "- one");
  await page.getByRole("button", { name: /Properties/ }).click();
  const key = page.locator(".page-property-add-key");
  await expect(key).toBeVisible();
  const m = await page.evaluate(() => {
    const scroll = document.querySelector(".page-scroll") as HTMLElement;
    const add = document.querySelector(".page-property-add") as HTMLElement;
    const fields = [...document.querySelectorAll<HTMLElement>(".page-properties input")];
    return {
      docWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollW: scroll.scrollWidth,
      clientW: scroll.clientWidth,
      addRight: add.getBoundingClientRect().right,
      fontSizes: fields.map((f) => Number.parseFloat(getComputedStyle(f).fontSize)),
    };
  });
  expect(m.docWidth).toBeLessThanOrEqual(m.innerWidth);
  expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
  expect(m.addRight).toBeLessThanOrEqual(m.innerWidth);
  // Under 16px, iOS zooms the page in on focus and leaves it there.
  expect(m.fontSizes.length).toBeGreaterThan(0);
  for (const size of m.fontSizes) expect(size).toBeGreaterThanOrEqual(16);
});

test("B-649: Back and Forward are greyed out when there is nowhere to go", async ({ page }) => {
  await openPage(page, "Phone History A", "- [[Phone History B]]");
  const back = page.getByRole("button", { name: "Back", exact: true });
  const forward = page.getByRole("button", { name: "Forward", exact: true });
  await expect(forward).toBeDisabled();

  await page.locator(".vr-outliner a", { hasText: "Phone History B" }).first().click();
  await expect(page).toHaveURL(/Phone%20History%20B$/);
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();

  await back.click();
  await expect(page).toHaveURL(/Phone%20History%20A$/);
  await expect(forward).toBeEnabled();

  await forward.click();
  await expect(page).toHaveURL(/Phone%20History%20B$/);
  await expect(forward).toBeDisabled();
});

test("B-650: the graph switcher closes when tapping outside it", async ({ page }) => {
  await openPage(page, "Phone Switcher Close", "- one");
  await page.getByRole("button", { name: "Switch graph" }).click();
  const popover = page.locator(".graph-switcher-popover");
  await expect(popover).toBeVisible();
  // A tap inside leaves it open.
  await popover.click({ position: { x: 5, y: 5 } });
  await expect(popover).toBeVisible();
  await page.locator(".page-scroll").tap({ position: { x: 200, y: 600 } });
  await expect(popover).toHaveCount(0);
});

test("B-651: the toolbar's task button cycles a block through the workflow, DOING/NOW included", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Phone Task Cycle", "- ship it");
  const cycle = page.locator(".cmd-toolbar button[aria-label='task.cycle']");
  // Enabled on a block that is not a task yet: this is how a task is started from the phone.
  await expect(cycle).toBeEnabled();
  const marker = outliner.locator(".vr-marker");

  await cycle.click();
  await expect(marker).toHaveAttribute("aria-checked", "false");
  const start = (await marker.getAttribute("class"))?.match(/vr-marker-(TODO|LATER)/)?.[1];
  expect(start).toBeDefined();

  await cycle.click();
  // TODO→DOING, LATER→NOW (B-608): whichever the graph's workflow started with.
  await expect(marker).toHaveClass(start === "LATER" ? /vr-marker-NOW/ : /vr-marker-DOING/);
  await expect(marker).toHaveAttribute("aria-checked", "mixed");
  await expect(editor(page)).toBeFocused();

  await cycle.click();
  await expect(marker).toHaveClass(/vr-marker-DONE/);
  await expect(marker).toHaveAttribute("aria-checked", "true");
  await expect(editor(page)).toHaveText("ship it");
});

test("B-651: the task checkbox is an icon with checkbox semantics, not a text glyph", async ({
  page,
}) => {
  const outliner = await openPage(page, "Phone Task Box", "- TODO buy milk");
  const box = outliner.getByRole("checkbox", { name: "Task: TODO" });
  await expect(box).toHaveAttribute("aria-checked", "false");
  await expect(box.locator("svg")).toHaveCount(1);
  await expect(box).toHaveText("");
  const size = await box.locator("svg").boundingBox();
  expect(size?.width ?? 0).toBeGreaterThanOrEqual(14);
  // `click`, not `tap`: in Chromium's touch emulation the marker's pointerdown preventDefault
  // swallows the click a tap would make (`tools/probes/phone-ui/marker-tap-chromium.spec.ts`).
  // A real tap on iOS does tick it (Simulator, `tools/probes/phone-ui/6-checkbox-tapped.png`).
  await box.click();
  await expect(outliner.getByRole("checkbox", { name: "Task: DONE" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(await rowTexts(page, outliner)).toEqual(["buy milk"]);
});
