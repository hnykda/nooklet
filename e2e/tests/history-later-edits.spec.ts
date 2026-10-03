/**
 * History's Undo and "Restore this version" must not throw away edits made AFTER the changes they
 * reverse (QA finding Q2, docs/bugs-inbox/qafix-views.md B-251). A graph-wide replace touches many
 * pages; restoring one of those pages walks back through the replace (and its undo) and used to
 * re-apply their before-images to every block they touched, anywhere — overwriting a later,
 * unrelated edit on another page with nothing on screen saying so. On the real graph that was 835
 * blocks, a page merge's 19 link rewrites and a Turn-into-page link.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, readBlocks, seedPage } from "../helpers/index.js";

function historyPath(name: string): string {
  return `/history/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function contents(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("Restore this version on one page keeps a later edit to a block on another page", async ({
  page,
}) => {
  const tag = "zqxhistlater";
  await seedPage(page, "History Later A", `- word ${tag}`);
  await seedPage(page, "History Later B", `- other ${tag}`);
  // One batch across both pages, then its undo: both are in B's timeline, and both touched A.
  const replaced = await api<{ batch_id: string }>(page, "graph.replace", {
    query: tag,
    replacement: "REPLACED",
  });
  await api(page, "batch.undo", { batch_id: replaced.batch_id });
  const [a] = await readBlocks(page, "History Later A");
  await api(page, "block.update", { id: a?.id, content: "A: important later edit" });

  await page.goto(historyPath("History Later B"));
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(3);
  await batches.nth(2).locator(".history-restore").click();
  // The in-page confirm (B-491), not `window.confirm`.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const confirmText = (await dialog.textContent()) ?? "";
  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator(".history-status")).toContainText("Restored: 2 changes undone.");

  expect(await contents(page, "History Later B")).toEqual([`other ${tag}`]);
  expect(await contents(page, "History Later A")).toEqual(["A: important later edit"]);
  // The confirm said what happens to other pages and to later edits there.
  expect(confirmText).toContain("other pages");
  expect(confirmText).toContain("later edits");
  // What was left alone is said on screen, with the page it is on.
  await expect(page.locator(".history-status")).toContainText("History Later A");
});

test("Undo of an old batch keeps a later edit to the same block and says so", async ({ page }) => {
  await seedPage(page, "History Later Undo", "- first draft");
  const [block] = await readBlocks(page, "History Later Undo");
  await api(page, "block.update", { id: block?.id, content: "second draft" });
  await api(page, "block.update", { id: block?.id, content: "third draft, keep me" });
  await page.goto(historyPath("History Later Undo"));
  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(3);
  // The middle batch ("first draft" -> "second draft"): its block was edited again afterwards.
  await batches.nth(1).locator(".history-undo").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".history-status")).toContainText("changed again later");
  expect(await contents(page, "History Later Undo")).toEqual(["third draft, keep me"]);
});
