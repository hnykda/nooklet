/**
 * A namespaced page's URL keeps its "/" as a path separator — `/page/NSPath Area/Leaf Page`,
 * never `/page/NSPath%20Area%2FLeaf%20Page` — whichever way you get there (B-331).
 *
 * The router takes `/page/*name`, a splat, so both spellings open the page; that is exactly why a
 * `%2F` went unnoticed. It still matters: it is the address you copy, middle-click, bookmark and
 * see in the status bar, and `routes/page-path.ts#pathToPageName` documents that the app never
 * produces one. Every way into a page is walked here, and every page link on each screen is read.
 *
 * Names are prefixed "NSPath" because the e2e server is shared across specs.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, MOD, openEditing, pagePath, readBlocks, seedPage } from "../helpers/index.js";

const LEAF = "NSPath Area/Leaf Page";
const LEAF_PATH = pagePath(LEAF); // "/page/NSPath%20Area/Leaf%20Page" — app-relative, see graphBase()

/**
 * This page's own `/g/<slug>` prefix (ADR 025) — read from the CURRENT page rather than a fixed
 * constant, since it is not known until the app has actually loaded and been redirected once.
 * Mirrors `apps/web/src/data/bootstrap.ts#samePathGraphPrefix`'s exact regex: every href/URL this
 * file compares against `pagePath(...)`'s app-relative output legitimately carries this prefix
 * now, the same way it does for a real visitor.
 */
function graphBase(page: Page): string {
  const m = /^\/g\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?=\/|$)/.exec(new URL(page.url()).pathname);
  return m?.[0] ?? "";
}

function withBase(page: Page, appRelativePath: string): string {
  return `${graphBase(page)}${appRelativePath}`;
}

/** Every `href` on screen that points into the app's page or history routes. `*=`, not `^=`: a
 * real href now legitimately starts with this page's own `/g/<slug>` prefix, not `/page/`/
 * `/history/` directly — matching the substring is what stays correct either way. */
async function appHrefs(page: Page): Promise<string[]> {
  return page
    .locator("a[href*='/page/'], a[href*='/history/']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
}

async function expectNoEncodedSlash(page: Page): Promise<void> {
  expect(new URL(page.url()).pathname).not.toMatch(/%2F/i);
  expect((await appHrefs(page)).filter((h) => /%2F/i.test(h))).toEqual([]);
}

async function expectAtLeaf(page: Page): Promise<void> {
  const expected = withBase(page, LEAF_PATH);
  await expect(page).toHaveURL((url) => url.pathname === expected);
  await expect(page.locator(".page-title-input")).toHaveValue(LEAF);
}

test.beforeEach(async ({ page }) => {
  await seedPage(page, LEAF, "- TODO nspathleafword on the leaf\n- second leaf block");
});

test("rendered links to a namespaced page carry its path: link, tag, label, query, embed", async ({
  page,
}) => {
  await seedPage(
    page,
    "NSPath Links",
    [
      `- plain [[${LEAF}]]`,
      `- tagged #[[${LEAF}]]`,
      `- [the leaf]([[${LEAF}]])`,
      "- ```query\n  text:nspathleafword\n  ```",
      `- {{embed [[${LEAF}]]}}`,
    ].join("\n"),
  );
  await page.goto(pagePath("NSPath Links"));
  const expectedLeafHref = withBase(page, LEAF_PATH);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-query-page a")).toHaveAttribute("href", expectedLeafHref);
  await expect(outliner.locator(".vr-embed-source")).toHaveAttribute("href", expectedLeafHref);
  await expect(outliner.locator("a.vr-tag")).toHaveAttribute("href", expectedLeafHref);
  // The plain link and the labelled one (and the embed's own content links, if any).
  const refs = outliner.locator("a.vr-page-ref:not(.vr-embed-source):not(.vr-query-page a)");
  expect(await refs.count()).toBeGreaterThanOrEqual(2);
  for (const href of await refs.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) {
    expect(href).toBe(expectedLeafHref);
  }
  await expectNoEncodedSlash(page);

  await outliner.locator(".vr-block-view", { hasText: "plain" }).locator("a.vr-page-ref").click();
  await expectAtLeaf(page);
  await expectNoEncodedSlash(page);
});

test("the palette opens a namespaced page at its path", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await palette.locator(".cmd-input").fill(LEAF);
  await expect(palette.locator(".cmd-row--active")).toContainText("Leaf Page");
  await page.keyboard.press("Enter");
  await expectAtLeaf(page);
  await expectNoEncodedSlash(page);
});

test("Alt+Enter on a [[namespaced link]] opens it at its path", async ({ page }) => {
  await openEditing(page, "NSPath Follow", `- go to [[${LEAF}]]`);
  await page.keyboard.press("Alt+Enter");
  await expectAtLeaf(page);
  await expectNoEncodedSlash(page);
});

test("the shelf's page card opens a namespaced page at its path", async ({ page }) => {
  await seedPage(page, "NSPath Shelf", `- shelve [[${LEAF}]]`);
  await page.goto(pagePath("NSPath Shelf"));
  await page
    .locator(".vr-block-view", { hasText: "shelve" })
    .locator("a.vr-page-ref")
    .click({ modifiers: ["Shift"] });
  const card = page.locator(".app-shelf .shelf-card").first();
  await expect(card).toContainText("Leaf Page");
  await expectNoEncodedSlash(page);
  await card.locator(".shelf-crumb").first().click();
  await expectAtLeaf(page);
  await expectNoEncodedSlash(page);
});

test("a linked reference from a namespaced page opens it at its path", async ({ page }) => {
  await seedPage(page, "NSPath Ref Target", "- a page others mention");
  await seedPage(page, "NSPath Refs/Source Page", "- mentions [[NSPath Ref Target]]");
  await page.goto(pagePath("NSPath Ref Target"));
  const group = page.locator(".linked-references .reference-group-page", {
    hasText: "Source Page",
  });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await expectNoEncodedSlash(page);
  await group.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === withBase(page, pagePath("NSPath Refs/Source Page")),
  );
  await expectNoEncodedSlash(page);
});

test("a tagged namespaced page opens at its path", async ({ page }) => {
  await api(page, "page.create", {
    name: "NSPath Tag",
    if_exists: "return",
    markdown: "- the tag",
  });
  await api(page, "page.create", {
    name: "NSPath Tagged/Member Page",
    if_exists: "return",
    properties: { tags: "NSPath Tag" },
  });
  await page.goto(pagePath("NSPath Tag"));
  const link = page.locator(".tagged-page-link", { hasText: "Member Page" });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === withBase(page, pagePath("NSPath Tagged/Member Page")),
  );
  await expectNoEncodedSlash(page);
});

test("the trash links a namespaced page, and its restore notice opens it at its path", async ({
  page,
}) => {
  await seedPage(page, "NSPath Trash/Block Page", "- keep\n- drop me");
  const blocks = await readBlocks(page, "NSPath Trash/Block Page");
  await api(page, "block.delete", { id: blocks.find((b) => b.content === "drop me")?.id });
  await seedPage(page, "NSPath Trash/Whole Page", "- whole");
  await api(page, "page.delete", { page: "NSPath Trash/Whole Page" });

  await page.goto("/trash");
  const blockRow = page.locator(".trash-row", { hasText: "drop me" });
  await expect(blockRow).toBeVisible();
  await expectNoEncodedSlash(page);

  const pageRow = page.locator(".trash-row", { hasText: "Whole Page" });
  await pageRow.locator(".trash-restore").click();
  await expect(page.locator(".trash-notice")).toContainText("Whole Page");
  await expectNoEncodedSlash(page);
  await page.locator(".trash-notice-link").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === withBase(page, pagePath("NSPath Trash/Whole Page")),
  );
  await expectNoEncodedSlash(page);
});

test("a namespaced page's history links back to the page at its path", async ({ page }) => {
  await page.goto(LEAF_PATH);
  await expect(page.locator(".page-history-link")).toHaveAttribute(
    "href",
    withBase(page, `/history/${LEAF.split("/").map(encodeURIComponent).join("/")}`),
  );
  await page.locator(".page-history-link").click();
  await expect(page.locator(".history-view h1")).toHaveText("History");
  await expect(page.locator(".history-back")).toHaveAttribute("href", withBase(page, LEAF_PATH));
  await expectNoEncodedSlash(page);
  await page.locator(".history-back").click();
  await expectAtLeaf(page);
});

test("search, all pages and tasks open a namespaced page at its path", async ({ page }) => {
  await page.goto("/search");
  await page.locator(".search-query-input").fill("nspathleafword");
  // The leaf's own block — "NSPath Links" has a query fence that names the same word.
  const hit = page.locator(".search-result", { hasText: "on the leaf" }).first();
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await hit.click();
  await expect(page).toHaveURL((url) => url.pathname === withBase(page, LEAF_PATH));
  await expectNoEncodedSlash(page);

  await page.goto("/pages");
  await expect(page.locator(".all-pages-name", { hasText: "Leaf Page" }).first()).toBeVisible();
  await expectNoEncodedSlash(page);

  await page.goto("/tasks");
  await expect(page.getByText("nspathleafword").first()).toBeVisible({ timeout: 15_000 });
  await expectNoEncodedSlash(page);
});

test("a copied link to a namespaced page opens it, whatever the name holds: Czech, %, ?, #, quotes", async ({
  page,
}) => {
  // What B-331 is about is the link used as a URL — copied, bookmarked, middle-clicked — so each
  // href is loaded fresh, with nothing but the address to go on. "?" and "#" would end the path if
  // a segment were not fully encoded, and "%" would not decode; the names with quotes and Czech are
  // shaped like the owner's graph (`TTRPG/VTM-alpha/Isabella D'Angelo`).
  const names = [
    "NSPath Odd/Příliš žluťoučký kůň",
    "NSPath Odd/50% off",
    "NSPath Odd/What? #1",
    `NSPath Odd/Isabella D'Angelo "Bella"`,
  ];
  for (const name of names) await seedPage(page, name, "- an odd leaf");
  await seedPage(page, "NSPath Odd Links", names.map((n) => `- to [[${n}]]`).join("\n"));
  await page.goto(pagePath("NSPath Odd Links"));
  const links = page.locator(".vr-outliner").first().locator("a.vr-page-ref");
  await expect(links).toHaveCount(names.length);
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  expect(hrefs).toEqual(names.map((n) => withBase(page, pagePath(n))));

  for (const [i, name] of names.entries()) {
    const href = hrefs[i] ?? "";
    await page.goto(href);
    await expect(page.locator(".page-title-input")).toHaveValue(name);
    // Still there once the page has loaded: no canonical-route redirect, no query or fragment split off.
    await expect(page).toHaveURL(
      (url) => url.pathname === href && url.search === "" && url.hash === "",
    );
  }
});
