/**
 * Search hits and Find & Replace groups name a journal day the way the rest of the app does
 * (B-354). Since ADR 018 a journal page is STORED as `2026-09-07` and SHOWN in the reader's title
 * format; both views printed the stored name, so with `E, dd.MM.yyyy` a hit read "2024-09-22 ›
 * todo" beside an agenda heading reading "Sun, 22.09.2024".
 */

import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, readBlocks, seedPage } from "../helpers/index.js";

// Thirty-one days back: an offset no other spec writes to.
const OFFSET = -31;
const WORD = "wombatjournalname";

/** `E, dd.MM.yyyy` for the day `OFFSET` from today, spelled the way date-fns spells it in English. */
function formattedDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + OFFSET);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${weekday}, ${dd}.${mm}.${d.getFullYear()}`;
}

async function useTitleFormat(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("nooklet.journalTitleFormat", "E, dd.MM.yyyy");
  });
}

test.beforeEach(async ({ page }) => {
  // Once per server: `page.append` is not idempotent, and a second copy of the block is a third
  // Find & Replace group.
  const existing = await readBlocks(page, isoOffset(OFFSET)).catch(() => []);
  if (!existing.some((b) => b.content.includes(WORD))) {
    await api(page, "page.append", {
      page: isoOffset(OFFSET),
      markdown: `- ${WORD} on a journal day`,
    });
  }
  await seedPage(page, "Journal Names Plain Page", `- ${WORD} on a plain page`);
  await useTitleFormat(page);
});

test("a search hit on a journal day names the day in the chosen title format (B-354)", async ({
  page,
}) => {
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill(WORD);
  const pages = page.locator(".search-result-page");
  await expect(pages).toHaveCount(2, { timeout: 15_000 });
  const texts = await pages.allTextContents();
  expect(texts).toContain(formattedDay());
  expect(texts).toContain("Journal Names Plain Page");
  expect(texts.join(" ")).not.toContain(isoOffset(OFFSET));
});

test("a Find & Replace group on a journal day names the day in the chosen title format (B-354)", async ({
  page,
}) => {
  await page.goto("/replace");
  await page.locator(".replace-query").fill(WORD);
  const groups = page.locator(".replace-result-page");
  await expect(groups).toHaveCount(2, { timeout: 15_000 });
  const texts = await groups.allTextContents();
  expect(texts.some((t) => t.startsWith(formattedDay()))).toBe(true);
  expect(texts.some((t) => t.startsWith("Journal Names Plain Page"))).toBe(true);
  expect(texts.join(" ")).not.toContain(isoOffset(OFFSET));
});
