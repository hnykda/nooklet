/**
 * B-324 at phone width (the fix's inbox entry: "Not checked at phone width by a test"). A row with
 * a scheduled date AND a deadline stacks both labels in its date column; on a 390 px screen that
 * column must neither push the page into horizontal scrolling nor squeeze the task's own text out.
 *
 * Page names start with "COV " (core-ops verification); the dates are years out so no other
 * spec's task falls near them.
 */

import { devices, expect, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

test("a phone's Tasks view row shows both labelled dates without overflowing (B-324)", async ({
  page,
}) => {
  await seedPage(
    page,
    "COV Phone Task Dates",
    [
      "- TODO covp a task with a long enough description to need the whole row on a phone",
      "  scheduled:: 2033-05-01 09:15",
      "  deadline:: 2033-05-20 17:45",
    ].join("\n"),
  );
  await page.goto("/tasks");
  const row = page
    .locator(".task-group", { hasText: "COV Phone Task Dates" })
    .locator(".task-row", { hasText: "covp a task" });
  await expect(row.locator(".task-due .task-date")).toHaveText([
    "Scheduled 2033-05-01 09:15",
    "Deadline 2033-05-20 17:45",
  ]);

  const m = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".task-row")].find((el) =>
      el.textContent?.includes("covp a task"),
    ) as HTMLElement;
    const box = (sel: string) => (r.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const dates = [...r.querySelectorAll(".task-date")].map((d) => d.getBoundingClientRect());
    return {
      viewport: window.innerWidth,
      docScroll: document.documentElement.scrollWidth,
      row: r.getBoundingClientRect(),
      due: box(".task-due"),
      dates: dates.map((d) => ({ left: d.left, right: d.right, top: d.top })),
    };
  });
  // No horizontal scroll, and the date column stays inside the row.
  expect(m.docScroll).toBeLessThanOrEqual(m.viewport);
  expect(m.due.right).toBeLessThanOrEqual(m.row.right + 0.5);
  for (const d of m.dates) expect(d.left).toBeGreaterThanOrEqual(m.row.left);
  // Stacked, not side by side, and the task text keeps most of the row.
  expect(m.dates[1]?.top ?? 0).toBeGreaterThan(m.dates[0]?.top ?? 0);
  expect(m.row.width - m.due.width).toBeGreaterThan(m.row.width * 0.5);
});
