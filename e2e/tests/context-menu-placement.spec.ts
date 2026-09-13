/**
 * The block context menu stays inside the window (B-351). It was clamped to `innerHeight - 320`,
 * the height it had before M8 added "Open on shelf" and the "Created … · Edited …" footer; at
 * ~510px tall, a right-click in the lower half of a 900px window put "Move to page…" and the
 * footer below the bottom edge, where nothing could scroll to them.
 *
 * The footer loads after the menu opens, so each check waits for it before measuring.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { openPage } from "../helpers/index.js";

const ROWS = Array.from({ length: 40 }, (_, i) => `- placement row ${i + 1}`).join("\n");

/** The row whose middle is nearest `fraction` of the viewport's height, scrolled there if need be. */
async function rowAt(page: Page, outliner: Locator, fraction: number): Promise<Locator> {
  const vh = page.viewportSize()?.height ?? 0;
  const index = await outliner.locator(".vr-row").evaluateAll((rows, target) => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - target);
      if (r.bottom < window.innerHeight && d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    });
    return best;
  }, vh * fraction);
  return outliner.locator(".vr-row").nth(index);
}

async function menuBox(
  page: Page,
): Promise<{ top: number; bottom: number; left: number; right: number }> {
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ctx-meta")).toBeVisible();
  // One frame for the placement to follow the footer's arrival.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

/** The whole menu is on screen and uncovered. On a phone the keyboard toolbar (shown while
 * editing, which a long-press starts) is fixed over the bottom of the window above the menu's
 * layer, so the bottom edge that counts is the toolbar's top. */
async function expectInsideWindow(page: Page): Promise<void> {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport");
  const box = await menuBox(page);
  const toolbar = page.locator(".cmd-toolbar");
  const toolbarTop = (await toolbar.count()) > 0 ? (await toolbar.boundingBox())?.y : undefined;
  const bottomEdge = Math.min(vp.height, toolbarTop ?? vp.height);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(bottomEdge);
  expect(box.right).toBeLessThanOrEqual(vp.width);
  // The last entry and the footer are the ones that fell off the bottom.
  for (const last of [
    page.locator(".ctx-menu .ctx-item", { hasText: "Move to page" }),
    page.locator(".ctx-menu .ctx-meta"),
  ]) {
    const b = await last.boundingBox();
    expect(b).not.toBeNull();
    expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(bottomEdge);
  }
}

test.describe("desktop window", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  for (const fraction of [0.3, 0.6, 0.9]) {
    test(`a right-click at ${fraction} of the window's height opens the whole menu on screen (B-351)`, async ({
      page,
    }) => {
      const outliner = await openPage(page, "Menu Placement Desk", ROWS);
      const row = await rowAt(page, outliner, fraction);
      await row.click({ button: "right", position: { x: 60, y: 8 } });
      await expectInsideWindow(page);
    });
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const cases = [
    { fraction: 0.3, side: "left" },
    { fraction: 0.6, side: "left" },
    { fraction: 0.85, side: "left" },
    // A 208px-wide menu at x≈350 of a 390px screen has to open to the pointer's left.
    { fraction: 0.6, side: "right" },
  ] as const;
  for (const { fraction, side } of cases) {
    test(`a long-press at ${fraction} of the screen's height, ${side} side, opens the whole menu on screen (B-351)`, async ({
      page,
      context,
    }) => {
      const outliner = await openPage(page, "Menu Placement Phone", ROWS);
      const row = await rowAt(page, outliner, fraction);
      const box = await row.boundingBox();
      if (!box) throw new Error("row has no box");
      // A real touch long-press: Chromium turns it into the `contextmenu` the row listens for.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.synthesizeTapGesture", {
        x: Math.round(side === "left" ? box.x + 80 : box.x + box.width - 16),
        y: Math.round(box.y + box.height / 2),
        duration: 1200,
        tapCount: 1,
        gestureSourceType: "touch",
      });
      await expectInsideWindow(page);
    });
  }
});
