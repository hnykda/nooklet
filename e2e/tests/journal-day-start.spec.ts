/**
 * Starting to write on a journal day: the moment a day goes from "nothing there" to an outline.
 *
 * Found by the M10 regression pass on the owner's graph (docs/bugs-inbox/qafix-regression.md):
 * - B-410: a day whose blocks had all been deleted rendered an outline with no rows and nowhere to
 *   type (the fresh-client half of B-410 is `journal-draft-sync.spec.ts`).
 * - B-411: on a calendar-opened day, text typed in the first moments after Enter on the draft was
 *   garbled or lost, because the block tree holding the editor was swapped for another one.
 *
 * Day offsets -71..-76 are this file's own (other specs use their own offsets; today is shared and
 * only read here).
 */

import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, pagePath, readBlocks } from "../helpers/index.js";

/** Click day `iso` in the journal calendar, paging back from the current month as needed. */
async function calendarPick(page: Page, iso: string): Promise<void> {
  await page.locator(".journal-calendar-toggle").click();
  const calendar = page.locator(".calendar");
  await expect(calendar).toBeVisible();
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const now = new Date();
  const monthsBack = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  for (let i = 0; i < monthsBack; i++) {
    await calendar.locator("button[aria-label='Previous month']").click();
  }
  await calendar.locator(".calendar-day", { hasText: new RegExp(`^${d}$`) }).click();
}

async function contents(page: Page, name: string): Promise<string[]> {
  try {
    return (await readBlocks(page, name)).map((b) => b.content);
  } catch {
    return [];
  }
}

test("a journal day whose blocks were all deleted still has somewhere to type (B-410)", async ({
  page,
}) => {
  const day = isoOffset(-71);
  await api(page, "page.append", { page: day, markdown: "- b410 deleted soon" });
  for (const b of await readBlocks(page, day)) {
    if (b.depth === 0) await api(page, "block.delete", { id: b.id });
  }
  expect(await contents(page, day)).toEqual([]);

  await page.goto("/journals");
  await calendarPick(page, day);
  const pinned = page.locator(".journal-day-pinned");
  await expect(pinned).toBeVisible();

  const start = pinned.locator(".vr-empty-start");
  await expect(start).toBeVisible();
  await start.click();
  await expect(pinned.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("b410 first line", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("b410 second line", { delay: 20 });

  await expect
    .poll(() => contents(page, day), { timeout: 15_000 })
    .toEqual(["b410 first line", "b410 second line"]);
});

test("a page an agent created empty has somewhere to type (B-410)", async ({ page }) => {
  const name = `B410 Empty Agent Page ${Date.now().toString(36)}`;
  await api(page, "page.create", { name });
  await page.goto(pagePath(name));

  const start = page.locator(".vr-outliner .vr-empty-start");
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("typed into an empty page", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("and a second block", { delay: 20 });

  await expect
    .poll(() => contents(page, name), { timeout: 15_000 })
    .toEqual(["typed into an empty page", "and a second block"]);
});
