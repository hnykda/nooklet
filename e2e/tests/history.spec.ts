/**
 * A page's history (M7 item 8, ADR 022): `/history/<name>` lists every batch that touched the
 * page, newest first, says what each did in words, shows a word diff for edited text, and can
 * undo one batch or "restore this version" (undo everything newer) after a confirm. Edits come
 * through the API so the batches are known; the browser does the undoing.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, pagePath, readBlocks, seedPage } from "../helpers/index.js";

function historyPath(name: string): string {
  return `/history/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** create (page + "one") -> edit "one" to "one edited" -> append "two": three batches. */
async function seedThreeBatches(page: Page, name: string): Promise<void> {
  await seedPage(page, name, "- one");
  const [first] = await readBlocks(page, name);
  await api(page, "block.update", { id: first?.id, old_str: "one", new_str: "one edited" });
  await api(page, "page.append", { page: name, markdown: "- two" });
}

async function contents(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("the timeline lists batches newest first, in words, with a diff of edited text", async ({
  page,
}) => {
  await seedThreeBatches(page, "History Page");
  await page.goto(historyPath("History Page"));
  await expect(page.locator(".history-view h1")).toHaveText("History");
  await expect(page.locator(".history-back")).toContainText("History Page");

  const batches = page.locator(".history-batch");
  await expect(batches).toHaveCount(3);
  await expect(batches.nth(0).locator(".history-summary")).toHaveText("1 block added");
  await expect(batches.nth(1).locator(".history-summary")).toHaveText("1 block edited");
  await expect(batches.nth(2).locator(".history-summary")).toHaveText(
    "page created; 1 block added",
  );
  await expect(batches.nth(0).locator(".history-origin")).toHaveText("api");

  // The edit shows what changed, word by word.
  const edit = batches.nth(1).locator(".history-entry");
  await expect(edit.locator(".history-entry-kind")).toHaveText("edited");
  await expect(edit.locator(".history-add")).toHaveText(" edited");
  await expect(edit.locator(".history-text")).toContainText("one edited");
});

test("Undo on one batch reverses just that batch, after a confirm", async ({ page }) => {
  await seedThreeBatches(page, "History Undo One");
  await page.goto(historyPath("History Undo One"));
  page.once("dialog", (d) => void d.accept());
  // The edit batch (middle): undoing it puts "one" back and leaves "two".
  await page.locator(".history-batch").nth(1).locator(".history-undo").click();
  await expect(page.locator(".history-status")).toHaveText("Undone.");
  await expect.poll(() => contents(page, "History Undo One")).toEqual(["one", "two"]);
  // The undo is itself a batch at the top of the timeline.
  await expect(page.locator(".history-batch").first().locator(".history-summary")).toHaveText(
    "1 block edited",
  );
  await expect(page.locator(".history-batch")).toHaveCount(4);
});

test("a dismissed confirm changes nothing", async ({ page }) => {
  await seedThreeBatches(page, "History Dismissed");
  await page.goto(historyPath("History Dismissed"));
  page.once("dialog", (d) => void d.dismiss());
  await page.locator(".history-batch").first().locator(".history-undo").click();
  await expect(page.locator(".history-batch")).toHaveCount(3);
  expect(await contents(page, "History Dismissed")).toEqual(["one edited", "two"]);
});

test("Restore this version undoes every newer batch, newest first, and reports it", async ({
  page,
}) => {
  await seedThreeBatches(page, "History Restore");
  expect(await contents(page, "History Restore")).toEqual(["one edited", "two"]);
  await page.goto(historyPath("History Restore"));

  const batches = page.locator(".history-batch");
  // The newest batch has nothing newer to undo, so it offers no Restore.
  await expect(batches.nth(0).locator(".history-restore")).toHaveCount(0);
  await expect(batches.nth(2).locator(".history-restore")).toHaveCount(1);

  let confirmText = "";
  page.once("dialog", (d) => {
    confirmText = d.message();
    void d.accept();
  });
  await batches.nth(2).locator(".history-restore").click();
  await expect(page.locator(".history-status")).toHaveText("Restored: 2 changes undone.");
  expect(confirmText).toContain("undoes the 2 newer changes");

  // Back to right after the create batch: just "one".
  await expect.poll(() => contents(page, "History Restore")).toEqual(["one"]);
  // The walk is history too: two undo batches on top of the original three.
  await expect(page.locator(".history-batch")).toHaveCount(5);

  await page.goto(pagePath("History Restore"));
  const rows = page.locator(".vr-outliner").first().locator(".vr-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("one");
});

test("a deleted page still has a history, with the deletion on top", async ({ page }) => {
  await seedThreeBatches(page, "History Deleted");
  await api(page, "page.delete", { page: "History Deleted" });
  await page.goto(historyPath("History Deleted"));
  await expect(page.locator(".history-batch").first().locator(".history-summary")).toHaveText(
    "page deleted; 2 blocks deleted",
  );
  await expect(page.locator(".history-batch")).toHaveCount(4);
});

test("the page title row links to the page's history, including namespaced names", async ({
  page,
}) => {
  await seedThreeBatches(page, "History Link/Child");
  await page.goto(pagePath("History Link/Child"));
  // Revealed on hover like the empty icon slot; the link is in the DOM regardless.
  const link = page.locator(".page-history-link");
  await expect(link).toHaveAttribute("href", historyPath("History Link/Child"));
  await link.click();
  await expect(page.locator(".history-view h1")).toHaveText("History");
  await expect(page.locator(".history-back")).toContainText("History Link/Child");
  await expect(page.locator(".history-batch")).toHaveCount(3);
});
