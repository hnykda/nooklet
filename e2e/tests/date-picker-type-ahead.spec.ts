/**
 * The date picker's "keys never reach the block" rule, at its two edges (B-147): keys typed after
 * `/scheduled` + Enter but before the picker is listening, and text that arrives with no keydown
 * at all (an IME commit, dictation, a virtual keyboard, an emoji picker).
 *
 * The gap before the picker listens is a worker read plus a lazy `import()` — 6-25 ms when it was
 * measured, so a test that simply typed fast would pass or fail on the machine's mood. Here the
 * picker's chunk is held back on the network (service workers blocked, so the request is
 * routable) and every key below lands inside the gap, every run. Page names start with
 * "Date Type Ahead" — no other spec uses them.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  editorText,
  expectEditorFocusedNow,
  isoOffset,
  openEditing,
} from "../helpers/index.js";

test.use({ serviceWorkers: "block" });

const CHUNK_DELAY_MS = 800;

async function scheduledOf(page: Page, name: string): Promise<string | undefined> {
  const out = await api<{ tree?: Array<{ properties?: Record<string, string> }> }>(
    page,
    "page.read",
    { page: name, format: "json" },
  );
  return out.tree?.[0]?.properties?.scheduled;
}

/** Hold the picker's lazily loaded chunk back, so opening it takes CHUNK_DELAY_MS. */
async function slowPickerChunk(page: Page): Promise<void> {
  await page.route(/\/DatePicker-[^/]*\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    await route.continue();
  });
}

/** ` /sched`, and Enter on the slash menu's Scheduled row — without waiting for the picker. */
async function startScheduled(page: Page): Promise<void> {
  await page.keyboard.type(" /sched");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu.locator(".cmd-row--active")).toHaveText("Scheduled");
  await page.keyboard.press("Enter");
}

test("keys typed before the picker is listening go to the picker, not the block", async ({
  page,
}, info) => {
  const name = `Date Type Ahead Keys ${info.repeatEachIndex}-${info.retry}`;
  await slowPickerChunk(page);
  await openEditing(page, name, "- fast typist");
  await startScheduled(page);
  await page.keyboard.type("tom");
  // Proof the keys really were typed into the gap: the picker is not there yet.
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect(page.locator(".date-picker")).toBeVisible({ timeout: CHUNK_DELAY_MS * 10 });
  await expect(page.locator(".date-picker .dp-text")).toHaveText("tom");
  expect(await editorText(page)).toBe("fast typist ");
  await page.keyboard.type("orrow");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect.poll(() => scheduledOf(page, name)).toBe(isoOffset(1));
  expect(await editorText(page)).toBe("fast typist ");
  await expectEditorFocusedNow(page, "after the picker set the date");
});

test("a whole date and Enter typed before the picker is listening sets the date once it is", async ({
  page,
}, info) => {
  const name = `Date Type Ahead Enter ${info.repeatEachIndex}-${info.retry}`;
  await slowPickerChunk(page);
  await openEditing(page, name, "- all at once");
  await startScheduled(page);
  await page.keyboard.type("tomorrow");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect
    .poll(() => scheduledOf(page, name), { timeout: CHUNK_DELAY_MS * 10 })
    .toBe(isoOffset(1));
  expect(await editorText(page)).toBe("all at once ");
  await expectEditorFocusedNow(page, "after the picker set the date");
});

test("Escape typed before the picker is listening cancels it: nothing opens, nothing is stored", async ({
  page,
}, info) => {
  const name = `Date Type Ahead Escape ${info.repeatEachIndex}-${info.retry}`;
  await slowPickerChunk(page);
  await openEditing(page, name, "- changed my mind");
  await startScheduled(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(CHUNK_DELAY_MS * 2);
  await expect(page.locator(".date-picker")).toHaveCount(0);
  expect(await scheduledOf(page, name)).toBeUndefined();
  // Escape was the picker's, so the block did not also drop into selection mode.
  await expectEditorFocusedNow(page, "after the cancelled picker");
  await page.keyboard.type("!");
  expect(await editorText(page)).toBe("changed my mind !");
});

test("text that arrives without a keydown goes to the open picker, not the block", async ({
  page,
}, info) => {
  const name = `Date Type Ahead Insert ${info.repeatEachIndex}-${info.retry}`;
  await openEditing(page, name, "- no keydown");
  await startScheduled(page);
  await expect(page.locator(".date-picker")).toBeVisible();
  // What an IME commit, dictation or a virtual keyboard sends: `beforeinput`/`input`, no keydown.
  await page.keyboard.insertText("zítra");
  await expect(page.locator(".date-picker .dp-text")).toHaveText("zítra");
  expect(await editorText(page)).toBe("no keydown ");
  await page.keyboard.press("Escape");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  expect(await scheduledOf(page, name)).toBeUndefined();
  expect(await editorText(page)).toBe("no keydown ");
});
