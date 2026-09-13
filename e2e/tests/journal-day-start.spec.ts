/**
 * Starting to write on a journal day: the moment a day goes from "nothing there" to an outline.
 *
 * Found by the M10 regression pass on the owner's graph (docs/bugs-inbox/qafix-regression.md):
 * - B-410: a day whose blocks had all been deleted rendered an outline with no rows and nowhere to
 *   type (the fresh-client half of B-410 is `journal-draft-sync.spec.ts`).
 * - B-411: on a calendar-opened day, text typed in the first moments after Enter on the draft was
 *   garbled or lost, because the block tree holding the editor was swapped for another one.
 *
 * Day offsets -101..-105 are this file's own, shifted by 10 per `--repeat-each` run (`ownDay`). They
 * stay clear of `pages.spec.ts`, which writes the 2nd of the month two months back (32-92 days).
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

/** This file's day `offset`, moved back 10 days per repetition so a repeat never finds it written. */
function ownDay(offset: number): string {
  return isoOffset(offset - 10 * test.info().repeatEachIndex);
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
  const day = ownDay(-101);
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

/** Blocks the replica's worker for `ms` (the technique of `autocomplete-busy-replica.spec.ts`). */
function occupyReplica(page: Page, ms: number): Promise<void> {
  const worker = page.workers().find((w) => w.url().includes("db.worker"));
  if (!worker) throw new Error(`no db worker among ${page.workers().map((w) => w.url())}`);
  return worker.evaluate((duration) => {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      // busy: nothing else runs on this thread until the loop ends
    }
  }, ms);
}

/** Opens `iso` from the calendar and returns its still-virtual draft. */
async function openVirtualDay(page: Page, iso: string) {
  expect(await contents(page, iso)).toEqual([]);
  await page.goto("/journals");
  await calendarPick(page, iso);
  const pinned = page.locator(".journal-day-pinned");
  const draft = pinned.locator(".vr-draft-input");
  await expect(draft).toBeVisible();
  return { pinned, draft };
}

async function typeThreeLines(page: Page, pauseMs = 0): Promise<void> {
  await page.keyboard.type("first line", { delay: 30 });
  await page.keyboard.press("Enter");
  if (pauseMs > 0) await page.waitForTimeout(pauseMs);
  await page.keyboard.type("second line", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("third line", { delay: 30 });
}

for (const [offset, pauseMs] of [
  [-102, 0],
  [-103, 300],
] as const) {
  test(`text typed ${pauseMs} ms after Enter on a calendar-opened day's draft lands intact (B-411)`, async ({
    page,
  }) => {
    const day = ownDay(offset);
    const { pinned, draft } = await openVirtualDay(page, day);
    await draft.click();
    await typeThreeLines(page, pauseMs);

    await expect
      .poll(() => contents(page, day), { timeout: 15_000 })
      .toEqual(["first line", "second line", "third line"]);
    await expect(pinned.locator(".cm-content")).toBeFocused();
  });
}

// The window QA hit on the real graph was the replica answering slowly: Enter wrote the day, and
// until the worker came back there was no editor anywhere, then a second tree replaced the first.
test("typing straight on after Enter while the replica is busy keeps every key (B-411)", async ({
  page,
}) => {
  const day = ownDay(-104);
  const { pinned, draft } = await openVirtualDay(page, day);
  await draft.click();
  await page.keyboard.type("first line", { delay: 30 });
  const busy = occupyReplica(page, 1_500);
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("third line", { delay: 30 });
  await busy;

  await expect
    .poll(() => contents(page, day), { timeout: 15_000 })
    .toEqual(["first line", "second line", "third line"]);
  await expect(pinned.locator(".cm-content")).toBeFocused();
});

test("a day started while the replica is busy from the first key keeps every line (B-411)", async ({
  page,
}) => {
  const day = ownDay(-105);
  const { pinned, draft } = await openVirtualDay(page, day);
  // Busy before the draft is even focused: nothing the day needs from the worker is ready when
  // Enter is pressed.
  const busy = occupyReplica(page, 2_000);
  await draft.click();
  await typeThreeLines(page);
  await busy;

  await expect
    .poll(() => contents(page, day), { timeout: 15_000 })
    .toEqual(["first line", "second line", "third line"]);
  await expect(pinned.locator(".cm-content")).toBeFocused();
  // The caret is where the typing stopped: at the end of the last line.
  await page.keyboard.type(" and on");
  await expect
    .poll(() => contents(page, day), { timeout: 15_000 })
    .toEqual(["first line", "second line", "third line and on"]);
});
