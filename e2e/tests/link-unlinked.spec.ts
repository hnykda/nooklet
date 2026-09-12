/**
 * "Link all" on the unlinked-references section (M7, research/13 §4.2 item 10): one click runs
 * `mentions.link` on the server, every plain mention becomes a `[[link]]`, the panel's two halves
 * swap their counts, and Undo (`batch.undo` with the returned batch_id) puts it all back. A real
 * server is the point — the rewrite, the FTS-backed candidate list and the undo all live there.
 */
import { expect, type Page, test } from "@playwright/test";
import { pagePath, readBlocks, seedPage } from "../helpers/index.js";

const TARGET = "Link Target";

async function seedGraph(page: Page): Promise<void> {
  await seedPage(page, TARGET, "- the target");
  await seedPage(
    page,
    "Link Source",
    "- talked about link target today\n- more about Link Target\n- nothing here",
  );
}

test("Link all links every mention, and Undo puts them back", async ({ page }) => {
  await seedGraph(page);
  await page.goto(pagePath(TARGET));

  const unlinkedSection = page.locator(".unlinked-references");
  await expect(unlinkedSection.locator(".references-toggle .reference-count")).toHaveText("2");
  await expect(page.locator(".linked-references")).toHaveCount(0);

  await unlinkedSection.getByRole("button", { name: "Link all" }).click();

  // The result line, with its undo, outlives the section it emptied.
  const status = page.locator(".references-status");
  await expect(status).toContainText("Linked 2 mention(s)");
  await expect(page.locator(".unlinked-references")).toHaveCount(0);
  await expect(page.locator(".linked-references .references-toggle .reference-count")).toHaveText(
    "2",
  );
  // What actually got written: the author's own casing, wrapped.
  await expect
    .poll(async () => (await readBlocks(page, "Link Source")).map((b) => b.content))
    .toEqual(["talked about [[link target]] today", "more about [[Link Target]]", "nothing here"]);

  await status.getByRole("button", { name: "Undo" }).click();
  await expect(status).toContainText("Put 2 mention(s) back");
  await expect(page.locator(".linked-references")).toHaveCount(0);
  await expect(page.locator(".unlinked-references .references-toggle .reference-count")).toHaveText(
    "2",
  );
  await expect
    .poll(async () => (await readBlocks(page, "Link Source")).map((b) => b.content))
    .toEqual(["talked about link target today", "more about Link Target", "nothing here"]);
});

test("a failed link says so and leaves the section alone", async ({ page }) => {
  await seedGraph(page);
  await page.route("**/api/v1/mentions.link", (route) => route.abort("failed"));
  await page.goto(pagePath(TARGET));

  const unlinkedSection = page.locator(".unlinked-references");
  await unlinkedSection.getByRole("button", { name: "Link all" }).click();
  await expect(page.locator(".references-error")).toContainText("Couldn't link the mentions");
  await expect(unlinkedSection.locator(".references-toggle .reference-count")).toHaveText("2");
  await expect(unlinkedSection.getByRole("button", { name: "Link all" })).toBeEnabled();
});
