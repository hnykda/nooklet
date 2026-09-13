/**
 * A journal day's "Scheduled and deadline" section (PLAN.md §8), against the real server and the
 * production build: today lists open tasks scheduled or due today plus overdue ones; any other
 * day lists what is scheduled or due that day; grouped by page; a click goes to the task or the
 * page; nothing at all when a day has nothing; follows the graph without a reload.
 *
 * Every task text carries a per-spec tag (`agx`) because the suite shares one server: other specs
 * create tasks of their own, and today's section may legitimately list some of them. Assertions
 * are about these tasks, never about the section's total size — except on days no other spec
 * touches.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, isoOffset, pagePath, readBlocks, seedPage } from "../helpers/index.js";

const PROJECT = "Agenda Project";
const ERRANDS = "Agenda Errands";

async function seed(page: Page): Promise<void> {
  await seedPage(
    page,
    PROJECT,
    [
      `- TODO agx due today\n  scheduled:: ${isoOffset(0)}`,
      `- DOING agx overdue deadline\n  deadline:: ${isoOffset(-3)}`,
      `- DONE agx finished today\n  scheduled:: ${isoOffset(0)}`,
      `- TODO agx in nine days\n  scheduled:: ${isoOffset(9)}`,
      `- TODO agx on minus twenty\n  deadline:: ${isoOffset(-20)}`,
      "- TODO agx undated",
    ].join("\n"),
  );
  await seedPage(
    page,
    ERRANDS,
    [
      `- TODO agx errand today\n  deadline:: ${isoOffset(0)}`,
      `- CANCELED agx canceled overdue\n  deadline:: ${isoOffset(-2)}`,
    ].join("\n"),
  );
}

function todayAgenda(page: Page): Locator {
  return page.locator(".journal-day-today .journal-agenda");
}

test.beforeEach(async ({ page }) => {
  await seed(page);
});

test("today lists what is scheduled or due today plus overdue, grouped by page", async ({
  page,
}) => {
  await page.goto("/journals");
  const agenda = todayAgenda(page);
  await expect(agenda).toBeVisible();
  await expect(agenda.locator(".journal-agenda-title")).toHaveText("Scheduled and deadline");

  const project = agenda.locator(".journal-agenda-group", {
    has: page.locator(".journal-agenda-page", { hasText: PROJECT }),
  });
  const errands = agenda.locator(".journal-agenda-group", {
    has: page.locator(".journal-agenda-page", { hasText: ERRANDS }),
  });
  // Oldest date first: the most overdue task leads.
  await expect(project.locator(".journal-agenda-item")).toHaveText([
    /agx on minus twenty/,
    /agx overdue deadline/,
    /agx due today/,
  ]);
  await expect(errands.locator(".journal-agenda-item")).toHaveText([/agx errand today/]);

  // Finished, canceled, undated, and not-yet-due tasks stay out.
  for (const absent of ["finished today", "canceled overdue", "undated", "in nine days"]) {
    await expect(agenda).not.toContainText(absent);
  }
  const overdue = project.locator(".journal-agenda-item", { hasText: "agx overdue deadline" });
  await expect(overdue.locator(".journal-agenda-date-overdue")).toHaveCount(1);
  await expect(overdue.locator(".vr-marker-DOING")).toBeVisible();
  const dueToday = project.locator(".journal-agenda-item", { hasText: "agx due today" });
  await expect(dueToday.locator(".journal-agenda-date")).toHaveText("Scheduled");
});

test("a row opens the task zoomed in on its page; a heading opens the page", async ({ page }) => {
  const blocks = await readBlocks(page, PROJECT);
  const target = blocks.find((b) => b.content.includes("agx due today"));
  expect(target).toBeDefined();

  await page.goto("/journals");
  const agenda = todayAgenda(page);
  await agenda.locator(".journal-agenda-row", { hasText: "agx due today" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?block=${target?.id}$`));
  await expect(page.locator(".page-view-back")).toContainText(PROJECT);

  await page.goto("/journals");
  await todayAgenda(page).locator(".journal-agenda-page", { hasText: ERRANDS }).click();
  await expect(page).toHaveURL(new RegExp(`${pagePath(ERRANDS)}$`));
  await expect(page.locator(".page-title-input")).toHaveValue(ERRANDS);
});

test("another day lists only what is scheduled or due on that day, with no overdue", async ({
  page,
}) => {
  // Only a day with a page appears in the stream; give minus-twenty one.
  const day = isoOffset(-20);
  await api(page, "page.append", { page: day, markdown: "- agx a note on minus twenty" });

  await page.goto(pagePath(day));
  await expect(page.locator(".vr-outliner").first()).toContainText("agx a note on minus twenty");
  const agenda = page.locator(".journal-agenda");
  await expect(agenda.locator(".journal-agenda-item")).toHaveText([/agx on minus twenty/]);
  // Its date is this day's own, so it is not called overdue here.
  await expect(agenda.locator(".journal-agenda-date-overdue")).toHaveCount(0);
  await expect(agenda).not.toContainText("agx overdue deadline");

  // The same day further down the journal stream carries the same section. Scroll the sentinel
  // into view until that day has loaded: other specs' journal days may come first.
  await page.goto("/journals");
  const inStream = page.locator(
    `.journal-day:not(.journal-day-today) .journal-agenda[data-day="${day.replaceAll("-", "")}"]`,
  );
  await expect
    .poll(async () => {
      await page.locator(".journal-stream-sentinel").scrollIntoViewIfNeeded();
      return inStream.count();
    })
    .toBe(1);
  await expect(inStream.locator(".journal-agenda-item")).toHaveText([/agx on minus twenty/]);
});

test("a day nobody has written in yet still shows what is scheduled then", async ({ page }) => {
  // Nine days ahead: no journal page (no spec writes one there), reached by its date the way a
  // date link reaches it.
  await page.goto(pagePath(isoOffset(9)));
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await expect(page.locator(".journal-agenda .journal-agenda-item")).toHaveText([
    /agx in nine days/,
  ]);
});

test("the section disappears, heading and all, once its day has nothing left", async ({ page }) => {
  // A day no other spec schedules anything on, with a page so it is a real journal day.
  const quiet = isoOffset(-61);
  await api(page, "page.append", { page: quiet, markdown: "- agx a quiet day" });
  await seedPage(page, "Agenda Quiet", `- WAITING agx the only task\n  scheduled:: ${quiet}`);
  const [task] = await readBlocks(page, "Agenda Quiet");

  await page.goto(pagePath(quiet));
  await expect(page.locator(".vr-outliner").first()).toContainText("agx a quiet day");
  // Present first — so the absence below is the section hiding, not the section never loading.
  await expect(page.locator(".journal-agenda .journal-agenda-item")).toHaveText([
    /agx the only task/,
  ]);

  // `properties`, not old_str/new_str: the text path rejects any block with a property line
  // (B-172, tools/probes/block-update-property-roundtrip.ts).
  await api(page, "block.update", { id: task?.id, properties: { marker: "DONE" } });
  await expect(page.locator(".journal-agenda")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Scheduled and deadline");
});

test("finishing a task elsewhere takes it off today's list without a reload", async ({ page }) => {
  await seedPage(page, "Agenda Live", `- TODO agx finish me\n  scheduled:: ${isoOffset(0)}`);
  const [block] = await readBlocks(page, "Agenda Live");

  await page.goto("/journals");
  const row = todayAgenda(page).locator(".journal-agenda-item", { hasText: "agx finish me" });
  await expect(row).toHaveCount(1);

  await api(page, "block.update", { id: block?.id, properties: { marker: "DONE" } });
  await expect(row).toHaveCount(0);
});
