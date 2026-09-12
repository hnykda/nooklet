/**
 * M7 block/page refactors (research/13 §4.2 item 3; ADR 020) through the real UI: "Turn into
 * page" and "Move to page…" from the bullet context menu, "Merge this page into…" from the
 * palette. Each runs a server op and pulls the result, so the assertions are on both what the
 * screen shows without a reload and what the API says the graph now is.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  MOD,
  openEditing,
  openPage,
  pagePath,
  readBlocks,
  rowTexts,
  seedPage,
} from "../helpers/index.js";

function menu(page: Page): Locator {
  return page.locator(".ctx-menu");
}

async function openMenuOn(page: Page, outliner: Locator, rowIndex: number): Promise<void> {
  await outliner.locator(".vr-row").nth(rowIndex).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

async function runItem(page: Page, label: string): Promise<void> {
  await menu(page).locator(".ctx-item", { hasText: label }).first().click();
  await expect(menu(page)).toHaveCount(0);
}

function picker(page: Page): Locator {
  return page.locator(".page-picker");
}

async function pickPage(page: Page, name: string): Promise<void> {
  await expect(picker(page)).toBeVisible();
  await picker(page).locator(".cmd-input").fill(name);
  await expect(picker(page).locator(".cmd-row--active")).toHaveText(name);
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
}

test("Turn into page: the first line names a page, the children move there, the block links to it", async ({
  page,
}) => {
  const outliner = await openEditing(
    page,
    "Refactor Turn",
    "- Aurora kickoff\n  - agenda\n    - budget\n  - attendees\n- unrelated",
  );
  await openMenuOn(page, outliner, 0);
  await runItem(page, "Turn into page");

  // The children leave this page without a reload — the pull after the op reaches the outliner.
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  const moved = await readBlocks(page, "Aurora kickoff");
  expect(moved.map((b) => [b.content, b.depth])).toEqual([
    ["agenda", 0],
    ["budget", 1],
    ["attendees", 0],
  ]);
  const source = await readBlocks(page, "Refactor Turn");
  expect(source.map((b) => b.content)).toEqual(["[[Aurora kickoff]]", "unrelated"]);

  // The new page opens with the children as its outline.
  await page.goto(pagePath("Aurora kickoff"));
  await expect.poll(() => rowTexts(page)).toEqual(["agenda", "budget", "attendees"]);
});

test("Move to page… asks for a page and moves the subtree to its end", async ({ page }) => {
  await seedPage(page, "Refactor Move Dst", "- already here");
  const outliner = await openEditing(page, "Refactor Move Src", "- keep\n- take me\n  - and me");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Move to page…");
  await pickPage(page, "Refactor Move Dst");

  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  expect((await readBlocks(page, "Refactor Move Dst")).map((b) => [b.content, b.depth])).toEqual([
    ["already here", 0],
    ["take me", 0],
    ["and me", 1],
  ]);
  await page.goto(pagePath("Refactor Move Dst"));
  await expect.poll(() => rowTexts(page)).toEqual(["already here", "take me", "and me"]);
});

test("Move to page… can create the page, and Escape moves nothing", async ({ page }) => {
  const outliner = await openEditing(page, "Refactor Move Create", "- stays\n- goes");
  await openMenuOn(page, outliner, 1);
  await runItem(page, "Move to page…");
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  expect(await rowTexts(page, outliner)).toEqual(["stays", "goes"]);

  await openMenuOn(page, outliner, 1);
  await runItem(page, "Move to page…");
  await expect(picker(page)).toBeVisible();
  await picker(page).locator(".cmd-input").fill("Refactor Brand New");
  await expect(picker(page).locator(".cmd-row--active")).toHaveText(
    'Create page "Refactor Brand New"',
  );
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  expect((await readBlocks(page, "Refactor Brand New")).map((b) => b.content)).toEqual(["goes"]);
});

test("Merge this page into… moves the blocks, rewrites links, aliases the old name, and lands on the target", async ({
  page,
}) => {
  await seedPage(page, "Refactor Merge B", "- b one");
  await seedPage(
    page,
    "Refactor Merge Linker",
    "- see [[Refactor Merge A]] and #[[refactor merge a]]",
  );
  await openPage(page, "Refactor Merge A", "- a one\n  - a two");

  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill("Merge this page into");
  await expect(palette.locator(".cmd-row--active")).toHaveText(/Merge this page into/);
  await page.keyboard.press("Enter");
  // The palette gives way to the picker rather than sitting underneath it.
  await expect(picker(page)).toBeVisible();
  await expect(page.locator(".cmd-palette:not(.page-picker)")).toHaveCount(0);
  await pickPage(page, "Refactor Merge B");

  await expect(page).toHaveURL(/\/page\/Refactor%20Merge%20B$/);
  await expect.poll(() => rowTexts(page)).toEqual(["b one", "a one", "a two"]);

  const linker = await readBlocks(page, "Refactor Merge Linker");
  expect(linker[0]?.content).toBe("see [[Refactor Merge B]] and #[[Refactor Merge B]]");
  // The old name still resolves — to the target, through the alias.
  const byOldName = await api<{ page: { name: string; properties?: Record<string, string> } }>(
    page,
    "page.read",
    { page: "Refactor Merge A", format: "json" },
  );
  expect(byOldName.page.name).toBe("Refactor Merge B");
  expect(byOldName.page.properties?.alias).toBe("Refactor Merge A");
});

test("the refactor commands are in the palette and the menu only where they apply", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  await palette.locator(".cmd-input").fill("Find and replace");
  await expect(palette.locator(".cmd-row--active")).toHaveText(/Find and replace/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/replace$/);
  await expect(page.locator(".replace-view")).toBeVisible();
});
