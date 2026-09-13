/**
 * A window left open across midnight (B-94, B-170, B-177). The unit tests drive the day signal with
 * a fake clock; this drives the real production build with Playwright's — the only place the
 * whole chain runs: timer → `currentDay()` → the stream's Today, the day's "Scheduled and deadline"
 * section, and a `today` query fence, with nothing written in between.
 *
 * The fake clock starts late TONIGHT (real date, 23:59:45) and only ever moves forward. Starting it
 * in the past would stamp any write with an older clock than the server's rows and it would be
 * silently lost to last-writer-wins, and more than a minute ahead of the server a write is refused
 * (HLC drift) — so these tests write through the API only, before the clock is installed.
 */

import { expect, test } from "@playwright/test";
import { isoOffset, pagePath, seedPage } from "../helpers/index.js";

/** Tonight, fifteen seconds before local midnight. */
function lateTonight(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 45);
}

const dayNumber = (iso: string): string => iso.replaceAll("-", "");

// A DEADLINE, not a scheduled date: the suite shares one server, and `query.spec.ts` counts every
// open task scheduled for tomorrow.
test.beforeEach(async ({ page }) => {
  await seedPage(page, "Midnight Source", `- TODO mdn due tomorrow\n  deadline:: ${isoOffset(1)}`);
});

test("the journal stream's Today and its agenda move to the new day at midnight", async ({
  page,
}) => {
  // Computed before the clock is faked: "tomorrow" by the real date is the fake clock's next day.
  const today = isoOffset(0);
  const tomorrow = isoOffset(1);
  await page.clock.install({ time: lateTonight() });
  await page.goto("/journals");

  const todaySection = page.locator(".journal-day-today");
  await expect(todaySection.locator(`.vr-draft-input, .vr-outliner`).first()).toBeVisible();
  const todayAgenda = (iso: string) =>
    todaySection.locator(`.journal-agenda[data-day="${dayNumber(iso)}"]`);
  // Other specs share this server and may list tasks of their own under today; only ours counts.
  await expect(todaySection).not.toContainText("mdn due tomorrow");

  await page.clock.fastForward("00:30");

  const row = todayAgenda(tomorrow).locator(".journal-agenda-item", {
    hasText: "mdn due tomorrow",
  });
  await expect(row).toHaveCount(1);
  // Due on its own day: not overdue, and the chip names no date.
  await expect(row.locator(".journal-agenda-date")).toHaveText("Deadline");
  // Yesterday's Today is an earlier day now, not a second Today.
  await expect(page.locator(".journal-day-today")).toHaveCount(1);
  await expect(todayAgenda(today)).toHaveCount(0);
});

test("a query fence asking for today answers for the new day after midnight", async ({ page }) => {
  await seedPage(page, "Midnight Query", "- ```query\n  marker:open deadline:today\n  ```");
  await page.clock.install({ time: lateTonight() });
  await page.goto(pagePath("Midnight Query"));

  const view = page.locator(".vr-query");
  await expect(view.locator(".vr-query-count")).toBeVisible();
  await expect(view).not.toContainText("mdn due tomorrow");

  await page.clock.fastForward("00:30");
  await expect(view).toContainText("mdn due tomorrow");
});
