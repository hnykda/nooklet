/**
 * B-841: a write made by a click or gesture on a rendered row — with nothing on the page edited or
 * selected before it — is undone by the very next Cmd/Ctrl+Z. Before the fix the step sat in the
 * tree's history and no key reached it: `historyEditorHost` only knew a tree that had been edited.
 *
 * Every test opens a FRESH page and touches nothing else first: that is the case that failed.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  editingRowIndex,
  MOD,
  openPage,
  rowDepths,
  rowTexts,
  runName,
} from "../helpers/index.js";

function unique(base: string): string {
  const info = test.info();
  return `${runName(base, info)} ${info.project.name}`;
}

/** The page's top-level blocks as the server has them: `marker content`. */
async function serverMarkers(page: Page, name: string): Promise<string[]> {
  const out = await api<{ tree?: Array<{ content: string; marker?: string | null }> }>(
    page,
    "page.read",
    { page: name, format: "json" },
  );
  return (out.tree ?? []).map((b) => `${b.marker ?? "-"} ${b.content}`);
}

test("B-841: a task marker clicked with nothing edited is undone by Cmd/Ctrl+Z, and redone", async ({
  page,
}) => {
  const name = unique("Click Undo Marker");
  const outliner = await openPage(page, name, "- TODO water the plants\n- another");
  const marker = outliner.locator(".vr-marker").first();
  await expect(marker).toHaveClass(/vr-marker-TODO/);

  await marker.click();
  await expect(marker).toHaveClass(/vr-marker-DONE/);
  // The click wrote; it did not enter editing.
  expect(await editingRowIndex(page, outliner)).toBe(-1);
  await expect
    .poll(() => serverMarkers(page, name))
    .toEqual(["DONE water the plants", "- another"]);

  await page.keyboard.press(`${MOD}+z`);
  await expect(marker).toHaveClass(/vr-marker-TODO/);
  await expect
    .poll(() => serverMarkers(page, name))
    .toEqual(["TODO water the plants", "- another"]);

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(marker).toHaveClass(/vr-marker-DONE/);
});

test("B-841: the collapse arrow clicked with nothing edited is undone by Cmd/Ctrl+Z", async ({
  page,
}) => {
  const name = unique("Click Undo Collapse");
  const outliner = await openPage(page, name, "- parent\n  - child\n- after");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["parent", "child", "after"]);

  const row = outliner.locator(".vr-row").first();
  await row.hover();
  await row.getByRole("button", { name: "Collapse block" }).click();
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["parent", "after"]);

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["parent", "child", "after"]);
});

/** A one-finger horizontal swipe across `row`, as touch pointer events (the gesture ignores a
 * mouse, `editor/gestures/swipe.ts`). Playwright's touchscreen only taps. */
async function swipe(row: Locator, dx: number): Promise<void> {
  await row.evaluate((el, dx) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x0 = r.left + r.width / 2;
    const ev = (type: string, x: number) =>
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
    el.dispatchEvent(ev("pointerdown", x0));
    for (let i = 1; i <= 8; i++) el.dispatchEvent(ev("pointermove", x0 + (dx * i) / 8));
    el.dispatchEvent(ev("pointerup", x0 + dx));
  }, dx);
}

test("B-841: a swipe-to-indent with nothing edited is undone by Cmd/Ctrl+Z", async ({ page }) => {
  const name = unique("Click Undo Swipe");
  const outliner = await openPage(page, name, "- first\n- second");
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0]);

  await swipe(outliner.locator(".vr-row").nth(1), 80);
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0]);
});
