/**
 * Every way a page comes into existence, and what has to be true right after: a `[[New/Nested]]`
 * link typed and clicked, a `#tag` on a block, the palette's Create, the missing-page view's
 * Create, a journal day picked from the calendar, and `page.create` through the API — each one
 * must show up where a person would next look for it (the sidebar, All Pages, the parent's
 * namespace list, the tag page's references) without a reload.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  clickAway,
  clickRow,
  editor,
  isoOffset,
  MOD,
  openEditing,
  openPage,
  pagePath,
  seedPage,
} from "../helpers/index.js";

async function pageKind(page: Page, name: string): Promise<string> {
  try {
    const r = await api<{ page: { kind: string } }>(page, "page.read", { page: name });
    return r.page.kind;
  } catch {
    return "missing";
  }
}

async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.locator(".app-sidebar");
  if ((await sidebar.count()) === 0) {
    await page.locator("button[aria-label='Toggle sidebar']").click();
  }
  await expect(sidebar).toBeVisible();
}

test("a typed [[Parent/Nested]] link, clicked, offers to create the page, and the parent then lists it", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Pages Parent", "- root\n- other");
  await page.keyboard.type(" see [[Pages Parent/Nested]]");
  // Render the first row (the link is only clickable in the rendered view).
  await clickRow(page, outliner, 1);
  await outliner.locator(".vr-page-ref", { hasText: "Pages Parent/Nested" }).click();

  await expect(page).toHaveURL(/\/page\/Pages%20Parent\/Nested$/);
  await expect(page.locator(".page-view-missing")).toContainText("doesn't exist yet");
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect.poll(() => pageKind(page, "Pages Parent/Nested")).toBe("page");

  // The namespace parent shows its new child, dimmed prefix and short name.
  await page.goto(pagePath("Pages Parent"));
  const ns = page.locator(".namespace-children");
  await expect(ns).toBeVisible();
  await expect(ns.locator(".namespace-child-link")).toHaveCount(1);
  await expect(ns.locator(".namespace-child-short")).toHaveText("Nested");
  await ns.locator(".namespace-child-link").click();
  await expect(page).toHaveURL(/\/page\/Pages%20Parent\/Nested$/);
});

test("a page created from the missing-page view can be typed into straight away", async ({
  page,
}) => {
  await page.goto(pagePath("Pages Fresh Typeable"));
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);

  // A brand-new page has no blocks. There must still be somewhere to type: a placeholder row
  // like the virtual journal day's, or a first block already waiting.
  const somewhereToType = page.locator(".vr-draft-input, .vr-block-view, .cm-content").first();
  await expect(somewhereToType).toBeVisible();
  await somewhereToType.click();
  await page.keyboard.type("first words");
  await clickAway(page);
  // Created on the client, so the server only has the page once sync has pushed it: a 404 in the
  // first polls is expected, not a failure — `api` throws on it, and a thrown error would end the
  // poll instead of retrying.
  await expect
    .poll(async () => {
      try {
        const r = await api<{ text: string }>(page, "page.read", { page: "Pages Fresh Typeable" });
        return r.text;
      } catch {
        return "";
      }
    })
    .toContain("first words");
});

test("a #tag typed on a block makes the tag page reachable, and it lists the block", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Pages Tag Source", "- about\n- other");
  await page.keyboard.type(" #PagesTagFresh ");
  await clickRow(page, outliner, 1);
  // The typed ref has to reach the server before the tag page asks for its backlinks; the next
  // test is the one about NOT having to wait.
  await expect
    .poll(async () => {
      const r = await api<{ linked: unknown[] }>(page, "page.backlinks", {
        target: "PagesTagFresh",
      });
      return r.linked.length;
    })
    .toBe(1);
  await outliner.locator(".vr-tag", { hasText: "#PagesTagFresh" }).click();

  await expect(page).toHaveURL(/\/page\/PagesTagFresh$/);
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);

  const linked = page.locator(".linked-references");
  await expect(linked).toBeVisible({ timeout: 15_000 });
  await expect(linked.locator(".reference-count")).toHaveText("1");
  await expect(linked.locator(".reference-group-page")).toHaveText("Pages Tag Source");
  await expect(linked.locator(".reference-item")).toContainText("about");
});

test("a tag page created straight after typing the tag shows the reference without a reload", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Pages Tag Quick Source", "- about\n- other");
  await page.keyboard.type(" #PagesTagQuick ");
  await clickRow(page, outliner, 1);
  await outliner.locator(".vr-tag", { hasText: "#PagesTagQuick" }).click();
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  // The reference exists on the server within moments; the panel has to pick it up on its own.
  await expect(page.locator(".linked-references .reference-count")).toHaveText("1", {
    timeout: 15_000,
  });
});

test("Cmd/Ctrl+K Create makes the page and All Pages shows it without a reload", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await palette.locator(".cmd-input").fill("Pages Palette Made");
  await palette.locator(".cmd-list >> text=/Create page/").first().click();

  await expect(page).toHaveURL(/\/page\/Pages%20Palette%20Made$/);
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect.poll(() => pageKind(page, "Pages Palette Made")).toBe("page");

  await openSidebar(page);
  await page.locator(".app-sidebar .sidebar-nav a[href='/pages']").click();
  await page.locator(".all-pages-filter").fill("Pages Palette Made");
  await expect(page.locator(".all-pages-row")).toHaveCount(1);
});

test("a page created through the API appears in the open sidebar without a reload", async ({
  page,
}) => {
  await page.goto("/journals");
  await openSidebar(page);
  // A name that sorts first, because the sidebar's "Pages" list is currently the first twelve
  // names alphabetically (B-76) — this test is about the list being LIVE, the next is about
  // which pages it shows.
  await expect(page.locator(".app-sidebar")).not.toContainText("A Pages Api Live");
  await api(page, "page.create", { name: "A Pages Api Live", markdown: "- via api" });
  await expect(page.locator(".app-sidebar")).toContainText("A Pages Api Live", {
    timeout: 15_000,
  });
  await page.locator(".app-sidebar a", { hasText: "A Pages Api Live" }).click();
  await expect(page.locator(".vr-outliner").first()).toContainText("via api");
});

test("the sidebar's Recent list shows the most recently edited pages first", async ({ page }) => {
  await page.goto("/journals");
  await openSidebar(page);
  await api(page, "page.create", { name: "Zz Pages Recent", markdown: "- just made" });
  await expect(page.locator(".app-sidebar")).toContainText("Zz Pages Recent", { timeout: 15_000 });
  // Headed "Recent" since B-222 (it was "Pages", under the nav link of the same name).
  const section = page.locator(".app-sidebar .sidebar-section", {
    has: page.locator("h2", { hasText: "Recent" }),
  });
  await expect(section.locator("li").first()).toHaveText("Zz Pages Recent");
});

test("a journal day opened from the calendar becomes a real journal page once typed into", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.locator(".journal-calendar-toggle").click();
  const calendar = page.locator(".calendar");
  await expect(calendar).toBeVisible();
  // Two months back, the 2nd: far enough from the offsets other specs write to that this day is
  // guaranteed to have no page yet.
  await calendar.locator("button[aria-label='Previous month']").click();
  await calendar.locator("button[aria-label='Previous month']").click();
  const label = (await calendar.locator(".calendar-month-label").textContent()) ?? "";
  await calendar.locator(".calendar-day", { hasText: /^2$/ }).click();

  const pinned = page.locator(".journal-day-pinned");
  await expect(pinned).toBeVisible();
  await expect(calendar).toHaveCount(0);
  const draft = pinned.locator(".vr-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("written from the calendar");
  await draft.blur();
  await expect(pinned.locator(".vr-outliner")).toContainText("written from the calendar");

  // Stored as a journal for that day: the ISO name is derived from the month the calendar showed.
  const monthDate = new Date(`1 ${label}`);
  const iso = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}-02`;
  await expect.poll(() => pageKind(page, iso)).toBe("journal");
  await pinned.locator(".journal-day-unpin").click();
  await expect(pinned).toHaveCount(0);
});

test("creating a journal-titled page from the missing-page view makes a journal, not an ordinary page", async ({
  page,
}) => {
  const future = isoOffset(400);
  await page.goto(pagePath(future));
  await expect(page.locator(".page-view-missing")).toBeVisible();
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  // B-23 closed this hole in the API; the UI must not reopen it.
  await expect.poll(() => pageKind(page, future)).toBe("journal");
});

test("renaming a page from its title keeps you on the page under its new name", async ({
  page,
}) => {
  await openPage(page, "Pages Rename Before", "- body text");
  const title = page.locator(".page-title-input");
  await title.fill("Pages Rename After");
  await title.press("Enter");

  await expect.poll(() => pageKind(page, "Pages Rename After")).toBe("page");
  await expect.poll(() => pageKind(page, "Pages Rename Before")).toBe("missing");
  // The view follows the rename rather than reporting its own page as missing.
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".vr-outliner").first()).toContainText("body text");
  await expect(page).toHaveURL(/Pages%20Rename%20After/);
});

test("a rename really renames: the new name reads back and the old one is gone", async ({
  page,
}) => {
  await openPage(page, "Pages Rename Data", "- body text");
  const title = page.locator(".page-title-input");
  await title.fill("Pages Rename Data Done");
  await title.press("Enter");
  await expect.poll(() => pageKind(page, "Pages Rename Data Done")).toBe("page");
  await expect.poll(() => pageKind(page, "Pages Rename Data")).toBe("missing");
  await page.goto(pagePath("Pages Rename Data Done"));
  await expect(page.locator(".vr-outliner").first()).toContainText("body text");
});

test("Cmd/Ctrl+O switches pages by name with a click", async ({ page }) => {
  await seedPage(page, "Pages Switch Target", "- reached");
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+o`);
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill("Pages Switch Target");
  await expect(palette.locator(".cmd-row--active")).toHaveText("Pages Switch Target");
  // Pages-only mode: no command rows (those carry a category subtitle).
  await expect(palette.locator(".cmd-row-subtitle")).toHaveCount(0);
  await palette.locator(".cmd-row--active").click();
  await expect(page).toHaveURL(/\/page\/Pages%20Switch%20Target$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("reached");
});

test("a page reached through a link before it exists shows Create, and Create is idempotent", async ({
  page,
}) => {
  await page.goto(pagePath("Pages Idempotent"));
  await page.locator(".page-view-missing button").click();
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect.poll(() => pageKind(page, "Pages Idempotent")).toBe("page");
  // Coming back later finds the same page, not a second one or an error.
  await page.goto(pagePath("Pages Idempotent"));
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".page-title-input")).toHaveValue("Pages Idempotent");
  const all = await api<{ items: Array<{ name: string }> }>(page, "page.list", { limit: 500 });
  expect(all.items.filter((p) => p.name === "Pages Idempotent")).toHaveLength(1);
});

test("the editor on a freshly created page works like any other", async ({ page }) => {
  await api(page, "page.create", { name: "Pages Fresh Editor", markdown: "- seeded" });
  await page.goto(pagePath("Pages Fresh Editor"));
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(2);
});
