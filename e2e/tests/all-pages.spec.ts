/**
 * All pages' columns and row delete (B-645): block and word counts from the local replica, sortable
 * by their headers, agreeing with the word-count plugin's own op; Delete through the title row's
 * flow and the in-app confirm dialog (B-491), cancelled and confirmed. Phone width:
 * `all-pages-phone.spec.ts`.
 *
 * Page names start with "Cols" plus this run's suffix: the suite shares one server.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, seedPage } from "../helpers/index.js";

function run(): string {
  const info = test.info();
  return `${info.repeatEachIndex}${info.retry}`;
}

async function seedThree(page: Page, prefix: string): Promise<void> {
  await page.goto("/journals");
  // Blocks / words: Small 1 / 2, Mid 2 / 5, Big 3 / 9 (the plugin's rule: whitespace runs).
  await seedPage(page, `${prefix} Small`, "- two words");
  await seedPage(page, `${prefix} Mid`, "- one two three\n- four  five");
  await seedPage(page, `${prefix} Big`, "- a b c\n  - d e f\n- g\th  i");
}

async function openFiltered(page: Page, prefix: string): Promise<void> {
  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill(prefix);
  await expect(page.locator(".all-pages-row")).toHaveCount(3);
}

const names = (page: Page) => page.locator(".all-pages-name").allTextContents();
const cells = (page: Page, col: string) =>
  page.locator(`.all-pages-row [data-col="${col}"]`).allTextContents();

test.describe("desktop", () => {
  test("block and word columns are there, agree with the plugin, and sort by their headers", async ({
    page,
  }) => {
    const prefix = `Cols ${run()}`;
    await seedThree(page, prefix);
    await openFiltered(page, prefix);

    for (const col of ["name", "blocks", "words", "created", "updated"]) {
      await expect(page.locator(`.all-pages-colhead[data-col="${col}"]`)).toBeVisible();
    }

    await page.getByRole("button", { name: "Sort by words" }).click();
    await expect
      .poll(() => names(page))
      .toEqual([`${prefix} Big`, `${prefix} Mid`, `${prefix} Small`]);
    expect(await cells(page, "words")).toEqual(["9", "5", "2"]);
    expect(await cells(page, "blocks")).toEqual(["3", "2", "1"]);

    // Same numbers as the word-count plugin's server op counts for each page.
    for (const [i, suffix] of ["Big", "Mid", "Small"].entries()) {
      const out = await api<{ word_count: number; block_count: number }>(page, "page.wordcount", {
        page: `${prefix} ${suffix}`,
      });
      expect(String(out.word_count)).toBe((await cells(page, "words"))[i]);
      expect(String(out.block_count)).toBe((await cells(page, "blocks"))[i]);
    }

    // Second click flips the direction.
    await page.getByRole("button", { name: "Sort by words" }).click();
    await expect
      .poll(() => names(page))
      .toEqual([`${prefix} Small`, `${prefix} Mid`, `${prefix} Big`]);

    await page.getByRole("button", { name: "Sort by name" }).click();
    await expect
      .poll(() => names(page))
      .toEqual([`${prefix} Big`, `${prefix} Mid`, `${prefix} Small`]);
    await expect(page.getByRole("button", { name: "Sort by name" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The counts follow an edit without a reload.
    await api(page, "page.append", { page: `${prefix} Small`, markdown: "- three more words" });
    await page.getByRole("button", { name: "Sort by blocks" }).click();
    await expect.poll(() => cells(page, "words")).toEqual(["9", "5", "5"]);
  });

  test("Delete asks in the in-app dialog: Cancel keeps the page, Delete removes the row and stays here", async ({
    page,
  }) => {
    const prefix = `Cols Del ${run()}`;
    await seedThree(page, prefix);
    await openFiltered(page, prefix);

    const row = page.locator(".all-pages-row", { hasText: `${prefix} Mid` });
    await row.hover();
    await row.getByRole("button", { name: `Delete ${prefix} Mid` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading")).toHaveText(`Delete "${prefix} Mid"?`);
    await expect(dialog).toContainText("and its 2 blocks will be moved to the Trash");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".all-pages-row")).toHaveCount(3);
    expect(
      (await api<{ page: { kind: string } }>(page, "page.read", { page: `${prefix} Mid` })).page,
    ).toBeTruthy();

    await row.hover();
    await row.getByRole("button", { name: `Delete ${prefix} Mid` }).click();
    await dialog.getByRole("button", { name: "Delete page" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".all-pages-row")).toHaveCount(2);
    await expect(page.locator(".all-pages-list")).not.toContainText(`${prefix} Mid`);
    // Unlike the title row's Delete, this one does not leave the list.
    await expect(page).toHaveURL(/\/pages$/);

    await page.goto("/trash");
    await expect(page.locator(".trash-row", { hasText: `${prefix} Mid` })).toHaveCount(1);
  });
});
