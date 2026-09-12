/**
 * The ```` ```query ```` fence (ADR 011, research/13 §4.2 item 1): results from the local
 * replica, grouped by page with a count; states in words; editing shows the raw fence; a click
 * navigates; results follow the graph without a reload; `/query` inserts the skeleton.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  clickAway,
  editor,
  editorText,
  isoOffset,
  openEditing,
  openPage,
  seedPage,
} from "../helpers/index.js";

const SOURCE = "Query Source";
const SOURCE_MARKDOWN = [
  "- TODO alpha #work",
  "  - a child note",
  "- DONE beta #work",
  `- TODO gamma #home\n  scheduled:: ${isoOffset(1)}`,
  "- plain note about work",
].join("\n");

const fence = (q: string): string => `- \`\`\`query\n  ${q}\n  \`\`\``;

async function openQuery(page: Page, name: string, q: string): Promise<Locator> {
  await seedPage(page, SOURCE, SOURCE_MARKDOWN);
  const outliner = await openPage(page, name, fence(q));
  const view = outliner.locator(".vr-query");
  await expect(view).toBeVisible();
  return view;
}

test("renders matching blocks grouped by page, with their children and a count", async ({
  page,
}) => {
  const view = await openQuery(page, "Query View Tasks", "TODO tag:work");
  await expect(view.locator(".vr-query-count")).toHaveText("1 block on 1 page");
  await expect(view.locator(".vr-query-page")).toHaveText(SOURCE);
  await expect(view.locator(".vr-query-hits > .vr-query-hit")).toHaveCount(1);
  await expect(view.locator(".vr-query-hit")).toHaveCount(2); // alpha + its child
  await expect(view).toContainText("alpha");
  await expect(view).toContainText("a child note");
  await expect(view).not.toContainText("beta");
  await expect(view).not.toContainText("gamma");
  await expect(view.locator(".vr-query-hit .vr-marker-TODO").first()).toBeVisible();
});

test("a scheduled window filters on the typed property", async ({ page }) => {
  const view = await openQuery(page, "Query View Window", "marker:open scheduled:tomorrow");
  await expect(view.locator(".vr-query-count")).toHaveText("1 block on 1 page");
  await expect(view).toContainText("gamma");
  await expect(view).not.toContainText("alpha");
});

test("a query with no matches says so", async ({ page }) => {
  const view = await openQuery(page, "Query View Empty", "tag:nothing-has-this-tag");
  await expect(view.locator(".vr-query-empty")).toHaveText("No blocks match.");
  await expect(view.locator(".vr-query-count")).toHaveText("0 blocks");
});

test("a query that does not parse says what is wrong", async ({ page }) => {
  const view = await openQuery(page, "Query View Broken", "TODO (tag:work");
  await expect(view.locator(".vr-query-error")).toContainText("Query error: missing closing )");
  await expect(view.locator(".vr-query-source mark")).toHaveText("(tag:work");
});

test("clicking a result navigates to that block; clicking the page name opens the page", async ({
  page,
}) => {
  const view = await openQuery(page, "Query View Nav", "TODO tag:work");
  await view.locator(".vr-query-hits > .vr-query-hit > .vr-query-hit-row").first().click();
  await expect(page).toHaveURL(/\/page\/Query%20Source\?block=/);
  // Not in edit mode on the page we left: the click was a navigation, not a click-to-edit.
  await expect(page.locator(".cm-content")).toHaveCount(0);

  await page.goBack();
  await expect(page.locator(".vr-query")).toBeVisible();
  await page.locator(".vr-query-page a").first().click();
  await expect(page).toHaveURL(/\/page\/Query%20Source$/);
});

test("clicking the fence itself edits the raw query text; leaving re-renders", async ({ page }) => {
  const view = await openQuery(page, "Query View Edit", "TODO tag:work");
  await view.locator(".vr-query-head").click();
  await expect(editor(page)).toBeFocused();
  expect(await editorText(page)).toBe("```query\nTODO tag:work\n```");
  await clickAway(page);
  await expect(page.locator(".vr-query .vr-query-count")).toHaveText("1 block on 1 page");
});

test("results follow the graph: a block added elsewhere appears without a reload", async ({
  page,
}) => {
  await seedPage(page, "Query Live Source", "- TODO one #livequery");
  const outliner = await openPage(page, "Query View Live", fence("TODO tag:livequery"));
  const view = outliner.locator(".vr-query");
  await expect(view.locator(".vr-query-count")).toHaveText("1 block on 1 page");

  await api(page, "page.append", { page: "Query Live Source", markdown: "- TODO two #livequery" });
  await expect(view.locator(".vr-query-count")).toHaveText("2 blocks on 1 page");
  await expect(view).toContainText("two");
});

test("a query block is never its own result", async ({ page }) => {
  const view = await openQuery(page, "Query View Self", "text:work");
  // Every block mentioning "work" on the source page, and NOT the fence that says `text:work`.
  await expect(view.locator(".vr-query-page")).toHaveCount(1);
  await expect(view.locator(".vr-query-page")).toHaveText(SOURCE);
});

test("/query inserts a fence skeleton around what was typed", async ({ page }) => {
  // A marker is block state, not text (tasks.spec.ts), so the editable content here is
  // `marker:open #work` — exactly the query a person would type before reaching for /query.
  await openEditing(page, "Query Slash", "- marker:open #work");
  await page.keyboard.type(" /query", { delay: 20 });
  const popup = page.locator(".cmd-popup").first();
  await expect(popup).toBeVisible();
  await popup.locator('[role="option"]').filter({ hasText: "Query" }).first().click();
  expect(await editorText(page)).toBe("```query\nmarker:open #work\n```");
  await clickAway(page);
  await expect(page.locator(".vr-query")).toBeVisible();
  await expect(page.locator(".vr-query .vr-query-text")).toHaveText("marker:open #work");
  await expect(page.locator(".vr-query .vr-query-count")).toContainText("block");
});
