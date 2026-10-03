/**
 * `nav.randomPage` (audit §2 #18, B-237): the palette command lands on a page, never the one on
 * screen, never a journal day, never an empty page. Which page is picked is random, so this
 * checks the invariants over several jumps; the exclusions themselves are pinned deterministically
 * by `apps/web/src/data/random-page.test.ts` (the query) and `random-page.test.ts` in
 * `commands/registrations` (the pick).
 */

import { expect, type Page, test } from "@playwright/test";
import { api, graphBase, isoOffset, MOD, pagePath, seedPage } from "../helpers/index.js";

async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  await expect(palette).toBeVisible();
  // `>` switches to commands mode only as a keystroke of its own (a `fill` of ">title" stays in
  // mixed mode, where Enter on the "Create page" row made a page called ">Open a random page").
  await page.keyboard.type(">");
  await page.keyboard.type(title);
  await expect(palette.locator(".cmd-row--active")).toHaveText(new RegExp(`^${title}`));
  await page.keyboard.press("Enter");
}

function currentPageName(page: Page): string | null {
  // ADR 025: strip this page's own /g/<slug> prefix before matching /page/....
  const path = new URL(page.url()).pathname.slice(graphBase(page).length);
  return path.startsWith("/page/") ? decodeURIComponent(path.slice("/page/".length)) : null;
}

test("Open a random page jumps to another page with content, never a journal day", async ({
  page,
}) => {
  await seedPage(page, "Random Alpha", "- alpha content");
  await seedPage(page, "Random Beta", "- beta content");
  await api(page, "page.create", { name: "Random Empty", if_exists: "return" });
  await api(page, "page.append", { page: isoOffset(-19), markdown: "- a journal day" });

  await page.goto(pagePath("Random Alpha"));
  await expect(page.locator(".vr-outliner").first()).toContainText("alpha content");

  for (let i = 0; i < 6; i++) {
    const before = currentPageName(page);
    await runFromPalette(page, "Open a random page");
    await expect.poll(() => currentPageName(page)).not.toBe(before);
    const name = currentPageName(page);
    expect(name, "a random jump landed on a page route").not.toBeNull();
    expect(name).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(name).not.toBe("Random Empty");
    await expect(page.locator(".page-view-body > .vr-outliner .vr-row").first()).toBeVisible();
  }
});

test("from a view that is not a page, it still lands on a page", async ({ page }) => {
  await seedPage(page, "Random Gamma", "- gamma content");
  await page.goto("/search");
  await expect(page.locator(".app-topbar")).toBeVisible();
  await runFromPalette(page, "Open a random page");
  await expect.poll(() => currentPageName(page)).not.toBeNull();
  await expect(page.locator(".page-view-body > .vr-outliner .vr-row").first()).toBeVisible();
});
