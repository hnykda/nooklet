/**
 * B-324: a Tasks view row showed one date — `dueDay`, the scheduled date whenever there is one — so
 * a task the Due window found by its deadline (B-171) was listed under a date outside that window,
 * with nothing saying whether it was a scheduled date or a deadline.
 *
 * Page names start with "CO " (core-ops) so they cannot collide with another spec's on the shared
 * server; the dates are years out so no other spec's task falls near them.
 */

import { expect, test } from "@playwright/test";
import { seedPage } from "../helpers/index.js";

test("a Tasks view row shows the scheduled date and the deadline, each labelled (B-324)", async ({
  page,
}) => {
  await seedPage(
    page,
    "CO Tasks Dates",
    [
      "- TODO cotd scheduled and deadline",
      "  scheduled:: 2032-04-01",
      "  deadline:: 2032-04-20",
      "- TODO cotd deadline with a time",
      "  deadline:: 2032-04-22 14:30",
      "- TODO cotd scheduled only",
      "  scheduled:: 2032-04-02",
      "- TODO cotd no dates",
    ].join("\n"),
  );
  await page.goto("/tasks");
  const rows = page.locator(".task-group", { hasText: "CO Tasks Dates" }).locator(".task-row");
  await expect(rows).toHaveCount(4);

  const datesOf = (text: string) => rows.filter({ hasText: text }).locator(".task-due .task-date");
  await expect(datesOf("scheduled and deadline")).toHaveText([
    "Scheduled 2032-04-01",
    "Deadline 2032-04-20",
  ]);
  await expect(datesOf("deadline with a time")).toHaveText(["Deadline 2032-04-22 14:30"]);
  await expect(datesOf("scheduled only")).toHaveText(["Scheduled 2032-04-02"]);
  await expect(datesOf("no dates")).toHaveCount(0);

  // The case the bug was about: found by its deadline, the row still says which date is which.
  await page.locator("label", { hasText: "Due from" }).locator("input").fill("2032-04-15");
  await page.locator("label", { hasText: "Due to" }).locator("input").fill("2032-04-21");
  await expect(rows).toHaveCount(1);
  await expect(datesOf("scheduled and deadline").filter({ hasText: "Deadline" })).toHaveText(
    "Deadline 2032-04-20",
  );
});
