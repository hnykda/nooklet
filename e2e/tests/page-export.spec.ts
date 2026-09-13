/**
 * Page portability and favourites (exposure audit §2 items 9, 10, 13): copy a page as markdown,
 * export it as the mirror's `.md` file, print it, and favourite it — from the page's title row and
 * from the palette. docs/bugs-inbox/impl-export.md B-220, B-221, B-222.
 *
 * The export test compares the download with the file the real server's mirror wrote for the same
 * page (the data dir is in global-setup's per-port state file). That is the claim the feature
 * makes — "the same text the mirror writes" — and the two are rendered by different processes
 * from different databases (the server's SQLite, the browser's replica), so only a byte compare of
 * both outputs checks it.
 *
 * Print is checked with a real `page.pdf()`: Chromium lays the page out for paper and fires
 * `beforeprint`/`afterprint` around it (verified 2026-09-13), so a listener registered here — after
 * the app's own — sees the DOM exactly as it is printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { api, pagePath, seedPage } from "../helpers/index.js";

const PORT = Number(process.env.NOOKLET_E2E_PORT ?? 6188);

function dataDir(): string {
  const state = JSON.parse(
    readFileSync(join(tmpdir(), `nooklet-e2e-state-${PORT}.json`), "utf8"),
  ) as { dataDir: string };
  return state.dataDir;
}

/** Nested blocks, a task with a priority and a date, a collapsed parent, a multi-line block, a
 * page property and Czech diacritics — the shapes a mirror file has to carry. */
const SEED_MARKDOWN = [
  "- Plan the trip to Brno",
  "  - TODO [#A] Book the train",
  "    scheduled:: 2026-09-20",
  "  - Collapsed parent",
  "    collapsed:: true",
  "    - hidden detail",
  "- Poznámka: **žluťoučký kůň**",
  "  second line of the note",
].join("\n");

/** What "Copy page as markdown" must produce for `SEED_MARKDOWN`: the mirror's text, ids off. */
const EXPECTED_COPY = [
  "type:: project",
  "- Plan the trip to Brno",
  "  - TODO [#A] Book the train",
  "    scheduled:: 2026-09-20",
  "  - Collapsed parent",
  "    collapsed:: true",
  "    - hidden detail",
  "- Poznámka: **žluťoučký kůň**",
  "  second line of the note",
  "",
].join("\n");

async function seedExportPage(page: Page, name: string): Promise<void> {
  await api(page, "page.create", {
    name,
    if_exists: "return",
    properties: { type: "project" },
    markdown: SEED_MARKDOWN,
  });
}

async function openPageView(page: Page, name: string): Promise<void> {
  await page.goto(pagePath(name));
  await expect(page.locator(".vr-outliner .vr-row").first()).toBeVisible();
}

async function openPageMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Page actions" }).click();
  await expect(page.locator(".page-actions-menu")).toBeVisible();
}

/** Run a command from the palette's commands mode, checking the row that Enter will run first. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill(title);
  await expect(palette.locator(".cmd-row--active")).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

test("Export as markdown downloads exactly the file the mirror wrote for the page", async ({
  page,
}) => {
  const name = "Export Mirror Parity";
  await seedExportPage(page, name);
  await openPageView(page, name);

  await openPageMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".page-actions-item", { hasText: "Export as markdown" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Export Mirror Parity.md");
  const downloaded = readFileSync(await download.path(), "utf8");

  // The server writes the mirror ~500 ms after the last commit; wait for it rather than guess.
  const mirrorFile = join(dataDir(), "pages", "Export Mirror Parity.md");
  await expect.poll(() => existsSync(mirrorFile), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => readFileSync(mirrorFile, "utf8"), { timeout: 15_000 }).toBe(downloaded);

  // And it is the lossless form: every block carries its ^id, which Copy leaves out.
  const blockLines = downloaded.split("\n").filter((l) => /^\s*- /.test(l));
  expect(blockLines).toHaveLength(5);
  for (const line of blockLines) expect(line).toMatch(/ \^[0-9a-z]{14}$/);
  expect(downloaded.replace(/ \^[0-9a-z]{14}$/gm, "")).toBe(EXPECTED_COPY);
  await expect(page.locator(".page-actions-notice")).toHaveText("Exported Export Mirror Parity.md");
});

test("Copy as markdown puts the page on the clipboard without ids, including a just-typed edit", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = "Copy Page Markdown";
  await seedExportPage(page, name);
  await openPageView(page, name);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

  await openPageMenu(page);
  await page.locator(".page-actions-item", { hasText: "Copy as markdown" }).click();
  await expect(page.locator(".page-actions-menu")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(EXPECTED_COPY);
  await expect(page.locator(".page-actions-notice")).toHaveText("Copied page as markdown");

  // Local-first: text typed a moment ago is in the copy, whether or not the server has it yet.
  const last = page
    .locator(".vr-outliner .vr-row", { hasText: "second line" })
    .locator(".vr-block-view");
  await last.click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" (edited)");
  await runFromPalette(page, "Copy page as markdown");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(EXPECTED_COPY.replace("second line of the note", "second line of the note (edited)"));
});

test("Export from the palette acts on the page the route shows", async ({ page }) => {
  const name = "Export Via Palette";
  await seedPage(page, name, "- only block");
  await openPageView(page, name);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    runFromPalette(page, "Export page as markdown"),
  ]);
  expect(download.suggestedFilename()).toBe("Export Via Palette.md");
  expect(readFileSync(await download.path(), "utf8")).toMatch(/^- only block \^[0-9a-z]{14}\n$/);
});

test("printing a long page prints all of it — without the chrome, collapsed children expanded, in light ink", async ({
  page,
}) => {
  // Dark theme on screen: printing must still use the light palette.
  await page.addInitScript(() => localStorage.setItem("nooklet.theme", "dark"));
  const name = "Print Long Page";
  const markdown = Array.from({ length: 120 }, (_, i) =>
    i === 3
      ? "- line 4 has a secret\n  collapsed:: true\n  - hidden child line"
      : `- line ${i + 1}`,
  ).join("\n");
  await seedPage(page, name, markdown);
  await openPageView(page, name);
  await page.locator("button[aria-label='Toggle sidebar']").click();
  await expect(page.locator(".app-sidebar")).toBeVisible();
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row", { hasText: "hidden child line" })).toHaveCount(0);

  const inkOf = () =>
    outliner
      .locator(".vr-block-view")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
  // On screen the dark palette really is on, or the light-ink check below would prove nothing.
  expect(await inkOf()).toBe("rgb(233, 233, 238)");

  // What the DOM holds while it is being laid out for paper.
  await page.evaluate(() => {
    const w = window as unknown as { __printed?: string[] };
    window.addEventListener("beforeprint", () => {
      w.__printed = [...document.querySelectorAll(".vr-outliner .vr-row")].map(
        (r) => r.textContent ?? "",
      );
    });
  });
  await page.emulateMedia({ media: "print" });

  for (const chrome of [".app-topbar", ".app-sidebar", ".help-fab", ".page-actions"]) {
    await expect(page.locator(chrome).first(), chrome).toBeHidden();
  }
  expect(await inkOf()).toBe("rgb(23, 23, 27)");
  // Bullets and guides are backgrounds, which paper drops by default: a PDF of the page had no
  // bullets until the outline asked for exact colour.
  const adjust = await outliner
    .locator(".vr-bullet-dot")
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue("print-color-adjust"));
  expect(adjust).toBe("exact");

  const pdf = await page.pdf();
  const sheets = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  // 121 rows at ~31px is several sheets. Before the print stylesheet it was exactly one: the
  // fixed shell clipped everything below the first screen.
  expect(sheets).toBeGreaterThanOrEqual(3);

  const printed = await page.evaluate(
    () => (window as unknown as { __printed?: string[] }).__printed,
  );
  expect(printed).toBeDefined();
  expect(printed?.some((t) => t.includes("hidden child line"))).toBe(true);
  expect(printed?.some((t) => t.includes("line 120"))).toBe(true);

  // `afterprint` puts the page back as it was: still collapsed, and nothing was written.
  await page.emulateMedia({ media: "screen" });
  await expect(outliner.locator(".vr-row", { hasText: "hidden child line" })).toHaveCount(0);
  const read = await api<{ tree?: Array<{ content: string; collapsed?: boolean }> }>(
    page,
    "page.read",
    { page: name, format: "json" },
  );
  expect(read.tree?.[3]?.collapsed).toBe(true);
});

// B-227: an ordinary page's title is an <input>, which cannot wrap — on paper a long name was clipped
// at the sheet's edge ("…nevejde cel"). What prints must be a heading that wraps, not the input.
test("a page title too long for one printed line prints whole", async ({ page }) => {
  const name =
    "Projekty/Velmi dlouhý název stránky, který se na papír nevejde celý do jednoho řádku";
  await seedPage(page, name, "- obsah");
  await openPageView(page, name);
  // Roughly an A4 sheet's printable width, so "one line" means what it means on paper.
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.emulateMedia({ media: "print" });

  await expect(page.locator("input.page-title-input")).toBeHidden();
  const heading = page.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible();
  const box = await heading.evaluate((el) => ({
    lines: Math.round(
      el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
    ),
    overflows: el.scrollWidth > el.clientWidth,
  }));
  expect(box.overflows).toBe(false);
  expect(box.lines).toBeGreaterThanOrEqual(2);

  // On screen the input is still the title, and the print-only heading is not there to read.
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("input.page-title-input")).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toBeHidden();
});

test("Print page from the palette closes the palette and opens the print dialog", async ({
  page,
}) => {
  await seedPage(page, "Print Via Palette", "- p");
  await openPageView(page, "Print Via Palette");
  await page.evaluate(() => {
    const w = window as unknown as { __printCalls: boolean[] };
    w.__printCalls = [];
    // The real dialog would block the test; what matters is that it is asked for, with the
    // palette already gone from the screen.
    window.print = () => {
      w.__printCalls.push(document.querySelector(".cmd-palette") !== null);
    };
  });
  await runFromPalette(page, "Print page");
  expect(
    await page.evaluate(() => (window as unknown as { __printCalls: boolean[] }).__printCalls),
  ).toEqual([false]);
});

test("the star in the title row favourites and unfavourites the page, and the sidebar follows", async ({
  page,
}) => {
  const name = "Star From Title Row";
  await seedPage(page, name, "- s");
  await openPageView(page, name);
  await page.locator("button[aria-label='Toggle sidebar']").click();
  const favourites = page.locator(".app-sidebar .sidebar-section", {
    has: page.locator("h2", { hasText: "Favourites" }),
  });

  const star = page.locator(".page-favorite-button");
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(star).toHaveAccessibleName("Remove from favourites");
  await expect(favourites.locator("a", { hasText: name })).toHaveCount(1);
  // A synced page property, visible to the API like any other.
  await expect
    .poll(async () => {
      const r = await api<{ page: { properties?: Record<string, string> } }>(page, "page.read", {
        page: name,
      });
      return r.page.properties?.favorite;
    })
    .toBe("true");

  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(favourites.locator("a", { hasText: name })).toHaveCount(0);
});

// B-229: each toggle read the stored value and wrote its opposite, so the second click of a double
// click read the value from before the first click's write landed, and both wrote "true".
test("double-clicking the star toggles twice and leaves the page as it was", async ({ page }) => {
  const name = "Star Double Click";
  await seedPage(page, name, "- s");
  await openPageView(page, name);
  const star = page.locator(".page-favorite-button");
  await expect(star).toHaveAttribute("aria-pressed", "false");

  await star.dblclick();
  await expect(page.locator(".page-actions-notice")).toHaveText("Removed from favourites");
  await expect(star).toHaveAttribute("aria-pressed", "false");
  const read = await api<{ page: { properties?: Record<string, string> } }>(page, "page.read", {
    page: name,
  });
  expect(read.page.properties?.favorite).toBeUndefined();
});

test("Toggle favourite from the palette stars the routed page; the sidebar's recent list reads Recent", async ({
  page,
}) => {
  const name = "Star From Palette";
  await seedPage(page, name, "- s");
  await openPageView(page, name);
  await runFromPalette(page, "Toggle favourite");
  await expect(page.locator(".page-favorite-button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".page-actions-notice")).toHaveText("Added to favourites");

  await page.locator("button[aria-label='Toggle sidebar']").click();
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar.locator(".sidebar-section h2", { hasText: "Favourites" })).toBeVisible();
  // B-222: the recent list was headed "Pages", directly under the "Pages" nav link.
  await expect(sidebar.locator(".sidebar-section h2")).toHaveText(["Favourites", "Recent"]);

  await runFromPalette(page, "Toggle favourite");
  await expect(page.locator(".page-favorite-button")).toHaveAttribute("aria-pressed", "false");
});
