/**
 * Editing a day BELOW Today in the journal stream (B-174). Every write refetches the stream; the
 * day sections used to be keyed by the entry objects that refetch rebuilds, so each debounced
 * write tore the section — and the editor in it — down and put up a copy. Today's own section was
 * never affected, which is why the specs that type into the journal (always Today) missed it.
 */

import { expect, test } from "@playwright/test";
import { api, editor, isoOffset, readBlocks } from "../helpers/index.js";

test("typing in an earlier day keeps editing across the write, and every key lands (B-174)", async ({
  page,
}) => {
  // A past day no other spec writes to, so its section is one of the stream's earlier days.
  const day = isoOffset(-9);
  await api(page, "page.append", { page: day, markdown: "- earlier day base" });

  await page.goto("/journals");
  const section = page.locator(".journal-day:not(.journal-day-today)", {
    hasText: "earlier day base",
  });
  await expect(section).toHaveCount(1);
  await section.locator(".vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");

  await page.keyboard.type("abc");
  // The write has happened (and with it the refetch that used to remount the section)…
  await expect
    .poll(async () => (await readBlocks(page, day)).map((b) => b.content))
    .toEqual(["earlier day baseabc"]);
  await page.waitForTimeout(500);
  // …and the caret is still in the block.
  await expect(editor(page)).toBeFocused();

  await page.keyboard.type("def");
  await expect
    .poll(async () => (await readBlocks(page, day)).map((b) => b.content))
    .toEqual(["earlier day baseabcdef"]);
  await expect(editor(page)).toBeFocused();
});
