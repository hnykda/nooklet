/**
 * A journal day's "Scheduled and deadline" section (PLAN.md §8), against the real server and the
 * production build: today lists open tasks scheduled or due today plus overdue ones, the overdue
 * past ten behind "Show all N overdue"; any other day lists what is scheduled or due that day;
 * dated blocks that are not tasks on their exact day only; grouped by page; a click goes to the task
 * or the page; nothing at all when a day has nothing; follows the graph without a reload.
 *
 * Every task text carries a per-spec tag (`agx`) because the suite shares one server: other specs
 * create tasks of their own, and today's section may legitimately list some of them. Assertions
 * are about these tasks, never about the section's total size — except on days no other spec
 * touches.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, isoOffset, MOD, pagePath, readBlocks, seedPage } from "../helpers/index.js";

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

/** Other specs on this server may leave overdue tasks of their own; open the full list so an
 * assertion about this spec's rows does not depend on how many there are. */
async function showAllOverdue(agenda: Locator): Promise<void> {
  const toggle = agenda.locator(".journal-agenda-more");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

/** Rows listed only for being overdue: every date on them is an overdue one. */
function overdueOnlyRows(agenda: Locator): Locator {
  const page = agenda.page();
  return agenda.locator(".journal-agenda-item", {
    has: page.locator(".journal-agenda-date-overdue"),
    hasNot: page.locator(".journal-agenda-date:not(.journal-agenda-date-overdue)"),
  });
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
  await showAllOverdue(agenda);

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

test("a dated block that is not a task is listed on its own day, with a bullet, never as overdue", async ({
  page,
}) => {
  const longAgo = isoOffset(-47);
  await seedPage(
    page,
    "Agenda Notes",
    [
      `- agx note for today\n  scheduled:: ${isoOffset(0)}`,
      `- agx note long ago\n  deadline:: ${longAgo}`,
    ].join("\n"),
  );

  await page.goto("/journals");
  const agenda = todayAgenda(page);
  await showAllOverdue(agenda);
  const note = agenda.locator(".journal-agenda-item", { hasText: "agx note for today" });
  await expect(note).toHaveCount(1);
  await expect(note.locator(".journal-agenda-bullet")).toBeVisible();
  await expect(note.locator(".vr-marker")).toHaveCount(0);
  await expect(note.locator(".journal-agenda-date")).toHaveText("Scheduled");
  // Its deadline passed 47 days ago, but a note has nothing to finish: not overdue under today.
  await expect(agenda).not.toContainText("agx note long ago");

  // On its own day it is listed, and not called overdue there.
  await page.goto(pagePath(longAgo));
  const onItsDay = page.locator(".journal-agenda");
  await expect(onItsDay.locator(".journal-agenda-item")).toHaveText([/agx note long ago/]);
  await expect(onItsDay.locator(".journal-agenda-date-overdue")).toHaveCount(0);
  await expect(onItsDay.locator(".journal-agenda-bullet")).toHaveCount(1);
});

test("today holds overdue tasks past ten behind 'Show all N overdue', and the count follows the graph", async ({
  page,
}) => {
  // Twelve tasks overdue by eleven years: older than anything another spec leaves — including the
  // literal dates some specs write, which turn overdue as the calendar moves — so they lead the
  // list. Closed again at the end: later specs count open tasks.
  const BACKLOG = "Agenda Backlog";
  await seedPage(
    page,
    BACKLOG,
    Array.from(
      { length: 12 },
      (_, i) =>
        `- TODO agx backlog ${String(i + 1).padStart(2, "0")}\n  deadline:: ${isoOffset(-4011 + i)}`,
    ).join("\n"),
  );
  const backlog = await readBlocks(page, BACKLOG);
  try {
    await page.goto("/journals");
    const agenda = todayAgenda(page);
    const toggle = agenda.locator(".journal-agenda-more");
    await expect(toggle).toHaveText(/^Show all \d+ overdue$/);
    const total = Number((await toggle.textContent())?.match(/\d+/)?.[0]);
    expect(total).toBeGreaterThanOrEqual(12);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Ten overdue rows, and they are the oldest: backlog 01..10, in order.
    await expect(overdueOnlyRows(agenda)).toHaveCount(10);
    const group = agenda.locator(".journal-agenda-group", {
      has: page.locator(".journal-agenda-page", { hasText: BACKLOG }),
    });
    const tenFirst = Array.from(
      { length: 10 },
      (_, i) => new RegExp(`agx backlog ${String(i + 1).padStart(2, "0")}`),
    );
    await expect(group.locator(".journal-agenda-item")).toHaveText(tenFirst);
    // Something due today is never held back (the seed in beforeEach).
    await expect(agenda).toContainText("agx due today");

    await toggle.click();
    await expect(toggle).toHaveText("Show fewer overdue");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(overdueOnlyRows(agenda)).toHaveCount(total);
    await expect(group.locator(".journal-agenda-item")).toHaveText([
      ...tenFirst,
      /agx backlog 11/,
      /agx backlog 12/,
    ]);

    // Finishing one elsewhere: one fewer, without a reload, and the list stays open.
    await api(page, "block.update", { id: backlog[0]?.id, properties: { marker: "DONE" } });
    await expect(overdueOnlyRows(agenda)).toHaveCount(total - 1);
    await expect(group.locator(".journal-agenda-item")).toHaveCount(11);

    await toggle.click();
    await expect(toggle).toHaveText(`Show all ${total - 1} overdue`);
    await expect(overdueOnlyRows(agenda)).toHaveCount(10);
  } finally {
    for (const b of backlog) {
      await api(page, "block.update", { id: b.id, properties: { marker: "DONE" } });
    }
  }
});

/** A stored block's marker, read from the server (`page.read`), never from the DOM. */
async function storedMarker(page: Page, name: string, id: string): Promise<string | null> {
  interface Node {
    id: string;
    marker?: string | null;
    children?: Node[];
  }
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const find = (nodes: Node[] | undefined): Node | undefined => {
    for (const n of nodes ?? []) {
      const hit = n.id === id ? n : find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(out.tree)?.marker ?? null;
}

test("a note turned into a task on another device joins today's overdue list live, and undo takes it back off", async ({
  page,
  browser,
}) => {
  // A second browser context is a second device: its own OPFS replica, reaching this page's
  // replica only through the server. A namespaced Czech page name, and a date ~24 years back —
  // older than anything another spec leaves — so the row leads the overdue list and is never
  // behind "Show all N overdue".
  const NOTES = "Agenda/Poznámky čáp";
  const longAgo = isoOffset(-9000);
  await seedPage(page, NOTES, `- agx přečíst smlouvu\n  deadline:: ${longAgo}`);
  const [note] = await readBlocks(page, NOTES);
  expect(note).toBeDefined();

  await page.goto("/journals");
  const agenda = todayAgenda(page);
  // Loaded (the beforeEach seed puts this spec's own task there), so the absence below is real.
  await expect(agenda).toContainText("agx due today");
  const row = agenda.locator(".journal-agenda-item", { hasText: "agx přečíst smlouvu" });
  await expect(row).toHaveCount(0);

  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const b = await other.newPage();
    await b.goto(pagePath(NOTES));
    const outliner = b.locator(".vr-outliner").first();
    await expect(outliner.locator(".vr-row").first()).toContainText("agx přečíst smlouvu");
    await outliner.locator(".vr-block-view").first().click();
    await expect(b.locator(".cm-content")).toBeFocused();

    await b.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => storedMarker(page, NOTES, note?.id as string)).toBe("TODO");
    // The first device, without a reload: now a task, so overdue under today.
    await expect(row).toHaveCount(1);
    await expect(row.locator(".vr-marker")).toHaveCount(1);
    await expect(row.locator(".journal-agenda-bullet")).toHaveCount(0);
    await expect(row.locator(".journal-agenda-date-overdue")).toHaveCount(1);
    const group = agenda.locator(".journal-agenda-group", {
      has: page.locator(".journal-agenda-item", { hasText: "agx přečíst smlouvu" }),
    });
    await expect(group.locator(".journal-agenda-page")).toHaveText(NOTES);

    // Undo on the device that made it a task: a note again, off today's list everywhere.
    await expect(b.locator(".cm-content")).toBeFocused();
    await b.keyboard.press(`${MOD}+z`);
    await expect.poll(() => storedMarker(page, NOTES, note?.id as string)).toBeNull();
    await expect(row).toHaveCount(0);

    // Still listed on its own day, as a note; its heading opens the namespaced Czech page.
    await page.goto(pagePath(longAgo));
    const onItsDay = page.locator(".journal-agenda .journal-agenda-item", {
      hasText: "agx přečíst smlouvu",
    });
    await expect(onItsDay.locator(".journal-agenda-bullet")).toHaveCount(1);
    await expect(onItsDay.locator(".journal-agenda-date-overdue")).toHaveCount(0);
    await page.locator(".journal-agenda-page", { hasText: NOTES }).click();
    await expect(page).toHaveURL(new RegExp(`${pagePath(NOTES)}$`));
    await expect(page.locator(".page-title-input")).toHaveValue(NOTES);
  } finally {
    await other.close();
    if ((await storedMarker(page, NOTES, note?.id as string)) !== null) {
      await api(page, "block.update", { id: note?.id, properties: { marker: "DONE" } });
    }
  }
});

test("a date picked on a note on another device lists it under today with a bullet, live; undo removes it", async ({
  page,
  browser,
}) => {
  const NOTES = "Agenda Picker Notes";
  await seedPage(page, NOTES, "- agx zavolat podlaháři");

  await page.goto("/journals");
  const agenda = todayAgenda(page);
  await expect(agenda).toContainText("agx due today");
  const row = agenda.locator(".journal-agenda-item", { hasText: "agx zavolat podlaháři" });
  await expect(row).toHaveCount(0);

  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const b = await other.newPage();
    await b.goto(pagePath(NOTES));
    const outliner = b.locator(".vr-outliner").first();
    await expect(outliner.locator(".vr-row").first()).toContainText("agx zavolat podlaháři");
    await outliner.locator(".vr-block-view").first().click();
    await expect(b.locator(".cm-content")).toBeFocused();
    await b.keyboard.press("End");

    await b.keyboard.type(" /deadl");
    const menu = b.locator(".cmd-popup").first();
    await expect(menu.locator(".cmd-row--active")).toHaveText("Deadline");
    await b.keyboard.press("Enter");
    await expect(b.locator(".date-picker")).toBeVisible();
    await b.keyboard.type("today");
    await b.keyboard.press("Enter");
    await expect(b.locator(".date-picker")).toHaveCount(0);
    // The picker handed the caret back: typing goes on in the block.
    await expect(b.locator(".cm-content")).toBeFocused();

    await expect(row).toHaveCount(1);
    await expect(row.locator(".journal-agenda-bullet")).toHaveCount(1);
    await expect(row.locator(".vr-marker")).toHaveCount(0);
    await expect(row.locator(".journal-agenda-date")).toHaveText("Deadline");

    await b.keyboard.press(`${MOD}+z`);
    await expect(row).toHaveCount(0);
  } finally {
    await other.close();
  }
});
