/**
 * The views around the editor: journal stream and calendar, references, search, All Pages, the
 * shelf, settings, the help menu, navigation keys, the palette, zoom breadcrumbs and collapsing.
 * Each test asserts the specific element that should change — a count, an exact title, a URL —
 * rather than that some text appears somewhere on the page.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  clickRow,
  editor,
  isoOffset,
  MOD,
  openEditing,
  openPage,
  pagePath,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

async function openSettings(page: Page): Promise<void> {
  await page.locator(".help-fab").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".set-panel")).toBeVisible();
}

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

// ── Journal stream ───────────────────────────────────────────────────────────────────────────────

test("the calendar jumps to an existing past day and Back to stream removes the pin", async ({
  page,
}) => {
  const day = isoOffset(-11);
  await api(page, "page.append", { page: day, markdown: "- eleven days ago" });
  await page.goto("/journals");
  await calendarPick(page, day);

  const pinned = page.locator(".journal-day-pinned");
  await expect(pinned).toBeVisible();
  await expect(pinned.locator(".vr-outliner")).toContainText("eleven days ago");
  // The pinned day is not ALSO listed further down the stream.
  await expect(page.locator(".journal-day", { hasText: "eleven days ago" })).toHaveCount(1);

  await pinned.locator(".journal-day-unpin").click();
  await expect(pinned).toHaveCount(0);
  await expect(page.locator(".journal-day", { hasText: "eleven days ago" })).toHaveCount(1);
});

test("the calendar's month navigation changes the label and Hide calendar closes it", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.locator(".journal-calendar-toggle").click();
  const calendar = page.locator(".calendar");
  const label = calendar.locator(".calendar-month-label");
  const start = await label.textContent();
  await calendar.locator("button[aria-label='Previous month']").click();
  await expect(label).not.toHaveText(start ?? "");
  await calendar.locator("button[aria-label='Next month']").click();
  await expect(label).toHaveText(start ?? "");
  await expect(calendar.locator(".calendar-day-today")).toHaveCount(1);
  await page.locator(".journal-calendar-toggle", { hasText: "Hide calendar" }).click();
  await expect(calendar).toHaveCount(0);
});

test("changing the journal date format re-titles every journal day immediately", async ({
  page,
}) => {
  const a = isoOffset(-13);
  const b = isoOffset(-15);
  await api(page, "page.append", { page: a, markdown: "- thirteen" });
  await api(page, "page.append", { page: b, markdown: "- fifteen" });
  await page.goto("/journals");
  const dayA = page.locator(".journal-day", { hasText: "thirteen" }).locator(".journal-day-title");
  const dayB = page.locator(".journal-day", { hasText: "fifteen" }).locator(".journal-day-title");
  await expect(dayA).toBeVisible();

  await openSettings(page);
  await page.locator("#set-journal-format").selectOption("yyyy-MM-dd");
  await expect(dayA).toHaveText(a);
  await expect(dayB).toHaveText(b);
  await expect(page.locator(".journal-day-today .journal-day-title")).toHaveText(
    `${isoOffset(0)} · Today`,
  );

  await page.locator("#set-journal-format").selectOption("dd.MM.yyyy");
  const [y, m, d] = a.split("-");
  await expect(dayA).toHaveText(`${d}.${m}.${y}`);
});

test("the journal format also re-titles a journal page's heading", async ({ page }) => {
  const day = isoOffset(-17);
  await api(page, "page.append", { page: day, markdown: "- seventeen" });
  await page.goto(pagePath(day));
  await openSettings(page);
  await page.locator("#set-journal-format").selectOption("yyyy-MM-dd");
  await expect(page.locator("h1.page-title-input")).toHaveText(day);
  await page.locator("#set-journal-format").selectOption("MMMM do, yyyy");
  await expect(page.locator("h1.page-title-input")).not.toHaveText(day);
});

// ── References ───────────────────────────────────────────────────────────────────────────────────

test("unlinked references count plain-text mentions and open on demand", async ({ page }) => {
  await seedPage(page, "Views Unlinked Target", "- the target");
  await seedPage(page, "Views Unlinked Source", "- mentions Views Unlinked Target in prose");
  await page.goto(pagePath("Views Unlinked Target"));
  const unlinked = page.locator(".unlinked-references");
  await expect(unlinked).toBeVisible({ timeout: 15_000 });
  await expect(unlinked.locator(".reference-count")).toHaveText("1");
  // Closed by default (linked is the half people read); opens on click.
  await expect(unlinked.locator(".reference-group")).toHaveCount(0);
  await unlinked.locator(".references-toggle").click();
  await expect(unlinked.locator(".reference-group")).toHaveCount(1);
  await expect(unlinked.locator(".reference-item")).toContainText("in prose");
});

test("a reference's page name opens that page, and the item opens the block zoomed", async ({
  page,
}) => {
  await seedPage(page, "Views Ref Target", "- target");
  await seedPage(page, "Views Ref Source", "- points at [[Views Ref Target]] here");
  const [src] = await readBlocks(page, "Views Ref Source");
  await page.goto(pagePath("Views Ref Target"));
  const linked = page.locator(".linked-references");
  await expect(linked).toBeVisible({ timeout: 15_000 });

  await linked.locator(".reference-group-page").click();
  await expect(page).toHaveURL(/\/page\/Views%20Ref%20Source$/);

  await page.goto(pagePath("Views Ref Target"));
  await expect(linked).toBeVisible({ timeout: 15_000 });
  await linked.locator(".reference-item-jump").click();
  await expect(page).toHaveURL(new RegExp(`/page/Views%20Ref%20Source\\?block=${src?.id}$`));
  await expect(page.locator(".vr-zoom-trail, .page-view-back").first()).toBeVisible();
});

test("a second tab of the same graph renders the page", async ({ page }) => {
  test.fixme(true, "B-81: a second tab sits on Loading… and never renders");
  await seedPage(page, "Views Second Tab", "- hello from tab one");
  await page.goto(pagePath("Views Second Tab"));
  await expect(page.locator(".vr-outliner .vr-row")).toHaveCount(1);
  const other = await page.context().newPage();
  await other.goto(pagePath("Views Second Tab"));
  await expect(other.locator(".vr-outliner .vr-row")).toHaveCount(1, { timeout: 20_000 });
  await expect(other.locator(".vr-outliner").first()).toContainText("hello from tab one");
  await other.close();
});

// ── Search ───────────────────────────────────────────────────────────────────────────────────────

test("keyword search finds a block, shows its page, and opens it", async ({ page }) => {
  await seedPage(page, "Views Search Hit", "- a sentence with the word marmoset in it");
  await page.goto("/search");
  await expect(page.locator(".search-hint")).toHaveText("Type to search.");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill("marmoset");
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });

  const hit = page.locator(".search-result", { hasText: "Views Search Hit" });
  await expect(hit).toHaveCount(1);
  await expect(hit.locator(".search-result-snippet")).toContainText("marmoset");
  await expect(page.locator(".search-summary")).toHaveText("1 result");
  await hit.locator(".search-result-open").click();
  await expect(page).toHaveURL(/\/page\/Views%20Search%20Hit/);
  await expect(page.locator(".vr-outliner").first()).toContainText("marmoset");
});

test("search says No results for a query nothing matches", async ({ page }) => {
  await page.goto("/search");
  await page.locator(".search-mode-toggle button", { hasText: "keyword" }).click();
  await page.locator(".search-query-input").fill("xqzv-no-such-word-anywhere");
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".search-summary")).toHaveText("0 results");
  await expect(page.locator(".search-empty")).toHaveText("No results.");
});

test("hybrid search says so when it fell back to keyword", async ({ page }) => {
  await seedPage(page, "Views Search Fallback", "- an axolotl sentence");
  await page.goto("/search");
  await page.locator(".search-query-input").fill("axolotl");
  await expect(page.locator(".search-loading")).toBeHidden({ timeout: 15_000 });
  // A fresh e2e graph has no embedding model, so hybrid must fall back — and say so — rather
  // than silently return keyword results under a hybrid label.
  await expect(page.locator(".search-summary")).toContainText(/1 result|Fell back/);
  await expect(page.locator(".search-result", { hasText: "Views Search Fallback" })).toHaveCount(1);
});

test("a failed search shows an error with Retry, and Retry recovers", async ({ page }) => {
  test.fixme(true, "B-80: a failed search sits on Searching… forever (B-10 is back for search)");
  await seedPage(page, "Views Search Retry", "- recoverable pangolin");
  let fail = true;
  await page.route("**/api/v1/search", (route) =>
    fail ? route.abort("failed") : route.continue(),
  );
  await page.goto("/search");
  await page.locator(".search-query-input").fill("pangolin");
  const error = page.locator(".search-error");
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText("Search failed");
  await expect(page.locator(".search-loading")).toHaveCount(0);

  fail = false;
  await error.locator(".search-retry").click();
  await expect(page.locator(".search-result", { hasText: "Views Search Retry" })).toHaveCount(1, {
    timeout: 15_000,
  });
});

// ── All Pages ────────────────────────────────────────────────────────────────────────────────────

test("All Pages sorts by name, shows journals only on request, and counts its rows", async ({
  page,
}) => {
  await seedPage(page, "Views AllPages Beta", "- b");
  await seedPage(page, "Views AllPages Alpha", "- a");
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill("Views AllPages");
  await page.locator(".all-pages-sort").selectOption("name");
  await expect(page.locator(".all-pages-row .all-pages-name")).toHaveText([
    "Views AllPages Alpha",
    "Views AllPages Beta",
  ]);
  await expect(page.locator(".all-pages-count")).toHaveText("2");

  // Journals are hidden until asked for.
  await page.locator(".all-pages-filter").fill(isoOffset(-11).slice(0, 7));
  await expect(page.locator(".all-pages-row")).toHaveCount(0);
  await page.locator(".all-pages-toggle input").check();
  expect(await page.locator(".all-pages-row").count()).toBeGreaterThan(0);
});

test("unstarring a page removes it from the sidebar favourites", async ({ page }) => {
  await seedPage(page, "Views Unstar", "- s");
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill("Views Unstar");
  const star = page.locator(".all-pages-row").first().locator(".all-pages-star");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await page.locator("button[aria-label='Toggle sidebar']").click();
  await expect(page.locator(".app-sidebar")).toContainText("Views Unstar");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  // Other specs star pages of their own, so the section may stay; this page must leave it.
  await expect(
    page.locator(".app-sidebar .sidebar-section", { hasText: "Favourites" }).locator("a", {
      hasText: "Views Unstar",
    }),
  ).toHaveCount(0);
});

test("an All Pages row opens its page", async ({ page }) => {
  await seedPage(page, "Views AllPages Open", "- opened from the list");
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill("Views AllPages Open");
  await page.locator(".all-pages-row .all-pages-name").first().click();
  await expect(page).toHaveURL(/\/page\/Views%20AllPages%20Open$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("opened from the list");
});

// ── Shelf ────────────────────────────────────────────────────────────────────────────────────────

test("a shelf card's crumb navigates to its page and the shelf stays put", async ({ page }) => {
  await seedPage(page, "Views Shelf Home", "- home block");
  const outliner = await openPage(page, "Views Shelf Src", "- shelve me\n- other");
  await outliner
    .locator(".vr-block-view")
    .first()
    .click({ modifiers: ["Shift"] });
  const shelf = page.locator(".app-shelf");
  await expect(shelf.locator(".shelf-card")).toHaveCount(1);

  await page.goto(pagePath("Views Shelf Home"));
  await expect(shelf.locator(".shelf-card")).toHaveCount(1);
  await shelf.locator(".shelf-crumb").click();
  await expect(page).toHaveURL(/Views%20Shelf%20Src\?block=/);
  await expect(shelf.locator(".shelf-card")).toHaveCount(1);
});

test("a shelved block updates live when edited in the main view", async ({ page }) => {
  const outliner = await openEditing(page, "Views Shelf Live", "- before edit\n- other");
  await clickRow(page, outliner, 1);
  await outliner
    .locator(".vr-row")
    .nth(0)
    .locator(".vr-block-view")
    .click({ modifiers: ["Shift"] });
  const card = page.locator(".app-shelf .shelf-card");
  await expect(card).toContainText("before edit");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("End");
  await page.keyboard.type(" and after");
  await expect(card).toContainText("before edit and after");
});

// ── Settings, help, shortcuts ────────────────────────────────────────────────────────────────────

test("the theme choice survives a reload", async ({ page }) => {
  await page.goto("/journals");
  await openSettings(page);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("Escape closes the help menu and the shortcuts dialog one layer at a time", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();
  await expect(page.locator(".help-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".help-menu")).toHaveCount(0);

  await page.locator(".help-fab").click();
  await page.locator(".help-item", { hasText: "Keyboard shortcuts" }).click();
  await expect(page.locator(".help-keys")).toBeVisible();
  await expect(page.locator(".help-menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".help-keys")).toHaveCount(0);
  await expect(page.locator(".help-menu")).toHaveCount(0);
});

test("the shortcuts dialog shows this platform's modifier and every category", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".help-fab").click();
  await page.locator(".help-item", { hasText: "Keyboard shortcuts" }).click();
  const dialog = page.locator(".help-keys");
  const paletteRow = dialog.locator("li", { hasText: "Open command palette" });
  await expect(paletteRow.locator("kbd")).toHaveText(
    process.platform === "darwin" ? "Cmd+K" : "Ctrl+K",
  );
  for (const category of ["Block", "Task", "Navigation", "Formatting", "App"]) {
    await expect(dialog.locator("h3", { hasText: category })).toHaveCount(1);
  }
  await dialog.locator(".help-close").click();
  await expect(dialog).toHaveCount(0);
});

test("Escape closes the help menu while a block is being edited, without selecting the block", async ({
  page,
}) => {
  test.fixme(true, "B-72: with a block in edit mode, Escape runs block.selectBlock instead");
  const outliner = await openEditing(page, "Views Help Escape", "- typing here");
  await page.locator(".help-fab").click();
  await expect(page.locator(".help-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".help-menu")).toHaveCount(0);
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(0);
});

// ── Navigation ───────────────────────────────────────────────────────────────────────────────────

test("Cmd/Ctrl+J, Cmd/Ctrl+Shift+F and Cmd/Ctrl+Shift+J go where they say", async ({ page }) => {
  await openPage(page, "Views Nav Keys", "- here");
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(page).toHaveURL(/\/search$/);
  await page.keyboard.press(`${MOD}+j`);
  await expect(page).toHaveURL(/\/journals$/);
  await page.goto(pagePath("Views Nav Keys"));
  await page.keyboard.press(`${MOD}+Shift+j`);
  await expect(page).toHaveURL(/\/journals$/);
});

test("the back and forward keybindings move through history", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".app-history button[aria-label='Back']").waitFor();
  await page.goto("/pages");
  await expect(page).toHaveURL(/\/pages$/);
  const back = process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft";
  const forward = process.platform === "darwin" ? "Meta+]" : "Alt+ArrowRight";
  await page.keyboard.press(back);
  await expect(page).toHaveURL(/\/journals$/);
  await page.keyboard.press(forward);
  await expect(page).toHaveURL(/\/pages$/);
});

test("the sidebar toggles with Cmd/Ctrl+\\ and its links reach every view", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+\\`);
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar).toBeVisible();
  for (const [href, expected] of [
    ["/pages", /\/pages$/],
    ["/tasks", /\/tasks$/],
    ["/search", /\/search$/],
    ["/graph", /\/graph$/],
    ["/journals", /\/journals$/],
  ] as const) {
    await sidebar.locator(`.sidebar-nav a[href='${href}']`).click();
    await expect(page).toHaveURL(expected);
  }
  await page.keyboard.press(`${MOD}+\\`);
  await expect(sidebar).toHaveCount(0);
});

// ── Palette ──────────────────────────────────────────────────────────────────────────────────────

test("the palette runs a command from the keyboard, > scopes it to commands, and Cmd/Ctrl+K toggles", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  const input = palette.locator(".cmd-input");
  await input.fill(">");
  await expect(input).toHaveAttribute("placeholder", "Type a command…");
  await input.fill("Open settings");
  await expect(palette.locator(".cmd-row--active")).toHaveText(/Open settings/);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".set-panel")).toBeVisible();
  await page.locator(".set-backdrop").click({ position: { x: 5, y: 5 } });

  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toHaveCount(0);
});

test("Enter on a highlighted page in the palette opens it", async ({ page }) => {
  test.fixme(true, "B-82: picking a page in the palette never opens it");
  await seedPage(page, "Views Palette Enter", "- reached by Enter");
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await palette.locator(".cmd-input").fill("Views Palette Enter");
  await expect(palette.locator(".cmd-row--active")).toHaveText("Views Palette Enter");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/page\/Views%20Palette%20Enter$/);
  await expect(page.locator(".vr-outliner").first()).toContainText("reached by Enter");
});

test("Escape and a backdrop click both close the palette", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toBeVisible();
  await page.locator(".cmd-overlay").click({ position: { x: 5, y: 5 } });
  await expect(palette).toHaveCount(0);
});

test("opening the palette while editing and closing it hands focus back to the editor", async ({
  page,
}) => {
  test.fixme(true, "B-72: with a block in edit mode, Escape runs block.selectBlock instead");
  await openEditing(page, "Views Palette Focus", "- keep typing");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.locator(".cmd-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-palette")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("keep typing!");
});

// ── Zoom and collapse ────────────────────────────────────────────────────────────────────────────

test("clicking a bullet zooms in, the breadcrumb walks back out, and the URL route works too", async ({
  page,
}) => {
  const outliner = await openPage(page, "Views Zoom Bullet", "- top\n  - middle\n    - leaf");
  await outliner.locator(".vr-row").nth(2).locator(".vr-bullet").click();
  const trail = page.locator(".vr-zoom-trail");
  await expect(trail.locator(".vr-crumb")).toHaveText(["Views Zoom Bullet", "top", "middle"]);
  await expect(trail.locator(".vr-crumb-current")).toHaveText("leaf");
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);

  await trail.locator(".vr-crumb", { hasText: "top" }).click();
  await expect(trail.locator(".vr-crumb-current")).toHaveText("top");
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(3);
  await trail.locator(".vr-crumb", { hasText: "Views Zoom Bullet" }).click();
  await expect(trail).toHaveCount(0);

  // The zoom ROUTE (what a search hit or a reference opens) shows the back button instead.
  const blocks = await readBlocks(page, "Views Zoom Bullet");
  const middle = blocks.find((b) => b.content === "middle");
  await page.goto(`${pagePath("Views Zoom Bullet")}?block=${middle?.id}`);
  await expect(page.locator(".page-view-back")).toContainText("Views Zoom Bullet");
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(2);
  await page.locator(".page-view-back").click();
  await expect(page).toHaveURL(/\/page\/Views%20Zoom%20Bullet$/);
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(3);
});

test("the collapse arrow hides children, shows their count, and it survives a reload", async ({
  page,
}) => {
  const outliner = await openPage(page, "Views Collapse Arrow", "- parent\n  - one\n  - two");
  const arrow = outliner.locator(".vr-row").first().locator(".vr-collapse-arrow");
  await arrow.click();
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(outliner.locator(".vr-child-count")).toHaveText("2");
  await expect(arrow).toHaveAttribute("aria-label", "Expand block");

  await page.reload();
  const reloaded = page.locator(".vr-outliner").first();
  await expect(reloaded.locator(".vr-row")).toHaveCount(1);
  await reloaded.locator(".vr-collapse-arrow").click();
  await expect(reloaded.locator(".vr-row")).toHaveCount(3);
});
