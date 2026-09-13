/**
 * Rendering and view gaps fixed together on `m9/render-views`: B-224 (a multi-line block's lines
 * run together), B-211 (a query result is found before the real row), B-200 (a page that does not
 * exist yet shows its references). The phone half of this work — B-225 — is
 * `render-views-phone.spec.ts`, since a device descriptor is per file.
 *
 * Page names here all start with "RV " so they cannot collide with another spec's on the shared
 * server.
 */

import { expect, test } from "@playwright/test";
import { openPage, readBlocks } from "../helpers/index.js";

test("a multi-line block renders each line on its own line (B-224)", async ({ page }) => {
  const outliner = await openPage(
    page,
    "RV Multiline",
    "- Poznámka: **žluťoučký kůň**\n  second line\n- plain first\n  plain second",
  );
  // Stored with the newline — the defect was in rendering, not in the import.
  const blocks = await readBlocks(page, "RV Multiline");
  expect(blocks.map((b) => b.content)).toEqual([
    "Poznámka: **žluťoučký kůň**\nsecond line",
    "plain first\nplain second",
  ]);

  const rows = outliner.locator(".vr-row .vr-block-view");
  await expect(rows).toHaveCount(2);
  for (const [index, [first, second]] of [
    ["žluťoučký kůň", "second line"],
    ["plain first", "plain second"],
  ].entries()) {
    const view = rows.nth(index);
    await expect(view.locator("br")).toHaveCount(1);
    // What a reader sees: the second line starts BELOW the first, not after it on the same line.
    const tops = await view.evaluate(
      (el, [a, b]) => {
        const topOf = (text: string): number => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent?.indexOf(text) ?? -1;
            if (i === -1) continue;
            const range = document.createRange();
            range.setStart(n, i);
            range.setEnd(n, i + 1);
            return range.getBoundingClientRect().top;
          }
          return Number.NaN;
        };
        return [topOf(a as string), topOf(b as string)];
      },
      [first, second],
    );
    expect(tops[1]).toBeGreaterThan((tops[0] ?? 0) + 5);
    // `innerText` follows layout, so it shows the break the way a copy would.
    expect(await view.evaluate((el) => (el as HTMLElement).innerText)).toContain(`\n${second}`);
  }
});

test("revealing a block lands on its row, not on a query result above it (B-211)", async ({
  page,
}) => {
  const name = "RV Query Reveal";
  const outliner = await openPage(
    page,
    name,
    [
      "- ```query",
      "  TODO tag:rvreveal",
      "  ```",
      `- put [[${name}]] on the shelf`,
      "- TODO rv reveal target #rvreveal",
    ].join("\n"),
  );
  const target = (await readBlocks(page, name)).find((b) => b.content.includes("rv reveal target"));
  expect(target).toBeDefined();
  const id = target?.id as string;
  // The query renders its result ABOVE the row it found — the shape the entry describes.
  await expect(outliner.locator(".vr-query-hit", { hasText: "rv reveal target" })).toHaveCount(1);

  // Every `[data-block-id]` for this block is its outliner row: that attribute is how "which DOM
  // node is block X" is answered (`shell/Shelf.tsx`, `live/RemoteFlashOverlay.tsx`).
  const owners = await page.evaluate(
    (blockId) =>
      [...document.querySelectorAll(`[data-block-id="${CSS.escape(blockId)}"]`)].map(
        (el) => el.className,
      ),
    id,
  );
  expect(owners).toHaveLength(1);
  expect(owners[0]).toContain("vr-row");

  // The real gesture: shelve the page, switch the card to its outline, click the task's entry.
  // `[data-from]`: the link in the block's text, not the query group's page heading.
  await outliner
    .locator(".vr-page-ref[data-from]", { hasText: name })
    .click({ modifiers: ["Shift"] });
  const card = page.locator(".shelf-card").first();
  await card.getByRole("button", { name: "Show page outline" }).click();
  await card.locator(".shelf-toc-link", { hasText: "rv reveal target" }).click();
  await expect(page.locator(`.vr-row[data-block-id="${id}"]`)).toHaveClass(/shelf-reveal-target/);
  await expect(outliner.locator(".vr-query-hit.shelf-reveal-target")).toHaveCount(0);
});
