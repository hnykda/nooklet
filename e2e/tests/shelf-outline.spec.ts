/**
 * The shelf's page-outline mode (M7, research/13 §4.2 item 7): a shelved page can show its
 * headings and top-level blocks as a table of contents, and clicking an entry scrolls the main
 * view to that block — navigating to the page first if something else is on screen. Needs the real
 * shell: the card, the router and the outliner's `data-block-id` rows all have to line up.
 */
import { expect, type Page, test } from "@playwright/test";
import { pagePath, seedPage } from "../helpers/index.js";

const TOC_PAGE = "Shelf TOC";

/** A page with headings at two depths and a plain top-level bullet, plus a page that links to it —
 * Shift-clicking that link is how the page lands on the shelf. */
async function seed(page: Page): Promise<void> {
  await seedPage(
    page,
    TOC_PAGE,
    [
      "- # Intro",
      "  - detail one",
      "  - ## Sub heading",
      "    - deep detail",
      "- plain top",
      "  - child detail",
    ].join("\n"),
  );
  await seedPage(page, "Shelf TOC Linker", "- read [[Shelf TOC]] first");
}

test("Outline mode lists headings and top-level blocks, and an entry scrolls to the block", async ({
  page,
}) => {
  await seed(page);
  await page.goto(pagePath("Shelf TOC Linker"));
  await expect(page.locator(".vr-outliner .vr-block-view").first()).toBeVisible();

  await page
    .locator(".vr-page-ref")
    .filter({ hasText: TOC_PAGE })
    .first()
    .click({
      modifiers: ["Shift"],
    });
  const card = page.locator(".shelf-card").first();
  await expect(card).toContainText("detail one");

  // Switch the card to its outline.
  await card.getByRole("button", { name: "Show page outline" }).click();
  const entries = card.locator(".shelf-toc-link");
  await expect(entries).toHaveText(["Intro", "Sub heading", "plain top"]);
  // Headings read as headings; the plain bullet does not.
  await expect(card.locator(".shelf-toc-heading")).toHaveCount(2);
  // The detail blocks are not in the map.
  await expect(card).not.toContainText("detail one");

  // Clicking an entry from ANOTHER page navigates there and lands on the block.
  await entries.filter({ hasText: "Sub heading" }).click();
  await expect(page).toHaveURL(
    new RegExp(`${encodeURIComponent(TOC_PAGE).replace("%20", "(%20| )")}$`),
  );
  const row = page.locator(".vr-row").filter({ hasText: "Sub heading" }).first();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/shelf-reveal-target/);

  // The card is still there, still in outline mode, and toggles back to content.
  await expect(card.locator(".shelf-toc-link")).toHaveCount(3);
  await card.getByRole("button", { name: "Show page content" }).click();
  await expect(card).toContainText("detail one");
});
