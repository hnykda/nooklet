/**
 * A reference in the references panel looks like the block on its page (B-550): the full block
 * rendered — task marker, a fenced code child, date chip, properties — its children nested (stored
 * folds honoured, a local toggle that writes nothing), a breadcrumb of its parents; a row opens its
 * block. It used to be the block's first line as plain inline text, children nowhere, and every
 * child of a linking block listed again as a flat line of its own.
 *
 * Needs the real stack: which blocks reference a page comes from the server (`page.backlinks`),
 * how they look from the browser's replica, and the two meet only in a real page.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function idOf(page: Page, pageName: string, content: string): Promise<string> {
  const hit = (await readBlocks(page, pageName)).find((b) => b.content === content);
  if (!hit) throw new Error(`no block "${content}" on ${pageName}`);
  return hit.id;
}

test("a referencing block renders nested and formatted under a breadcrumb; a child row opens that child", async ({
  page,
}) => {
  const target = "RR Target";
  const source = "RR Source";
  await seedPage(page, target, "- the target");
  await seedPage(
    page,
    source,
    [
      "- Project notes",
      "  - TODO call about [[RR Target]]",
      `    scheduled:: ${isoOffset(2)}`,
      "    owner:: Dan",
      "    - first child",
      "      - grandchild",
      "    - ```js",
      "      const answer = 42;",
      "      ```",
      "    - folded child",
      "      collapsed:: true",
      "      - hidden under the fold",
    ].join("\n"),
  );
  const grandchild = await idOf(page, source, "grandchild");
  const notes = await idOf(page, source, "Project notes");

  await page.goto(pagePath(target));
  const linked = page.locator(".linked-references");
  // The heading counts blocks, as `page.backlinks` does: the linking block and its five descendants.
  await expect(linked.locator(".references-toggle .reference-count")).toHaveText("6");
  // …but they are ONE reference on screen, not six flat lines.
  const item = linked.locator(".reference-item");
  await expect(item).toHaveCount(1);

  await expect(item.locator(".reference-breadcrumb-item")).toHaveText(["Project notes"]);

  const rows = item.locator(".vr-embed-item");
  await expect(rows.locator(".vr-embed-row > .vr-embed-content > :first-child")).toHaveText([
    "call about RR Target",
    "first child",
    "grandchild",
    "const answer = 42;",
    "folded child",
  ]);
  expect(
    await rows.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).style.getPropertyValue("--depth")),
    ),
  ).toEqual(["0", "1", "2", "1", "1"]);

  const root = rows.first();
  await expect(root.locator(".vr-marker-TODO")).toBeVisible();
  await expect(root.locator(".vr-date[data-field='scheduled']")).toHaveAttribute(
    "data-value",
    isoOffset(2),
  );
  await expect(root.locator(".vr-prop[data-key='owner'] .vr-prop-value")).toHaveText("Dan");
  // The fence is a real code block, not the text "```js".
  await expect(item.locator("pre.vr-fence code")).toHaveText("const answer = 42;");
  await expect(item).not.toContainText("```");
  // Stored fold honoured; nothing editable in the panel.
  await expect(item).not.toContainText("hidden under the fold");
  await expect(item.locator("[contenteditable='true'], textarea")).toHaveCount(0);

  // Unfold it here: shown, and nothing written.
  const folded = rows.filter({ hasText: "folded child" });
  await folded.locator(".vr-embed-toggle").click();
  await expect(item).toContainText("hidden under the fold");
  await expect(page).toHaveURL(/\/page\/RR%20Target$/);
  // Give a stray write time to reach the server before asserting there was none.
  await page.waitForTimeout(800);
  const read = await api<{ text: string }>(page, "page.read", { page: source });
  expect(read.text).toMatch(/- folded child[^\n]*\n\s*collapsed:: true/);

  // A child row opens that child, zoomed on its page.
  await rows.filter({ hasText: "grandchild" }).locator(".vr-embed-row").click();
  await expect(page).toHaveURL(new RegExp(`/page/RR%20Source\\?block=${grandchild}$`));

  // The breadcrumb opens the parent block.
  await page.goto(pagePath(target));
  await linked.locator(".reference-breadcrumb-item", { hasText: "Project notes" }).click();
  await expect(page).toHaveURL(new RegExp(`/page/RR%20Source\\?block=${notes}$`));
});

test("with nested references, the filter, the sort and Link all still work", async ({ page }) => {
  const target = "RRF Target";
  await seedPage(page, target, "- the target");
  await seedPage(
    page,
    "RRF Alpha",
    "- about [[RRF Target]]\n  - child mentions [[RRF Other]]\n- second [[RRF Target]] block",
  );
  await page.waitForTimeout(20);
  await seedPage(page, "RRF Beta", "- [[RRF Target]] from beta");
  await seedPage(page, "RRF Plain", "- plain RRF Target mention\n  - nested plain child");

  await page.goto(pagePath(target));
  const linked = page.locator(".linked-references");
  const count = linked.locator(".references-toggle .reference-count");
  const groups = linked.locator(".reference-group-page");
  await expect(count).toHaveText("4");
  // "child mentions" sits inside "about": three rows, not four.
  await expect(linked.locator(".reference-item")).toHaveCount(3);
  await expect(groups).toHaveText(["RRF Beta", "RRF Alpha"]);

  // Sort by name, and back.
  await linked.getByRole("button", { name: /Sorted by most recent/ }).click();
  await expect(groups).toHaveText(["RRF Alpha", "RRF Beta"]);
  await linked.getByRole("button", { name: /Sorted by page name/ }).click();
  await expect(groups).toHaveText(["RRF Beta", "RRF Alpha"]);

  // Filter to the page only the nested child mentions: that child becomes a row of its own, with
  // the block it sits in as its breadcrumb.
  await linked.getByRole("button", { name: "Filter linked references" }).click();
  const popover = page.getByRole("dialog", { name: "Filter linked references" });
  const other = popover.locator(".references-filter-option", { hasText: "RRF Other" });
  await other.click();
  await expect(count).toHaveText("1");
  const only = linked.locator(".reference-item");
  await expect(only).toHaveCount(1);
  await expect(only.locator(".reference-breadcrumb-item")).toHaveText(["about RRF Target"]);
  await expect(only.locator(".vr-embed-content")).toHaveText(["child mentions RRF Other"]);
  // Exclude it: the other three blocks, three rows — and "about" still shows its real child, since
  // a reference renders the block's subtree as it is, not a filtered one.
  await other.click();
  await expect(count).toHaveText("3");
  await expect(linked.locator(".reference-item")).toHaveCount(3);
  await expect(
    linked.locator(".reference-item", { hasText: "about" }).locator(".vr-embed-item"),
  ).toHaveCount(2);
  await other.click();
  await page.keyboard.press("Escape");
  await expect(count).toHaveText("4");
  await expect(linked.locator(".reference-item")).toHaveCount(3);

  // Unlinked: the mention renders with its child, and Link all links it.
  const unlinked = page.locator(".unlinked-references");
  await expect(unlinked.locator(".references-toggle .reference-count")).toHaveText("1");
  await unlinked.locator(".references-toggle").click();
  await expect(unlinked.locator(".reference-item .vr-embed-content")).toHaveText([
    "plain RRF Target mention",
    "nested plain child",
  ]);
  await unlinked.getByRole("button", { name: "Link all" }).click();
  await expect(page.locator(".references-status")).toContainText("Linked 1 mention(s)");
  await expect(page.locator(".unlinked-references")).toHaveCount(0);
  // Now linked: the mention and its child are two more blocks, one more row.
  await expect(count).toHaveText("6");
  await expect(linked.locator(".reference-item")).toHaveCount(4);
  await expect(
    linked.locator(".reference-item", { hasText: "nested plain child" }).locator(".vr-embed-item"),
  ).toHaveCount(2);

  await page.locator(".references-status").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".references-status")).toContainText("Put 1 mention(s) back");
  await expect(count).toHaveText("4");
  await expect(linked.locator(".reference-item")).toHaveCount(3);
});

test("a numbered list item keeps its number in the references panel, and so do its children (B-551)", async ({
  page,
}) => {
  const target = "RRN Target";
  await seedPage(page, target, "- the target");
  await seedPage(
    page,
    "RRN Steps",
    [
      "- step one",
      "  list:: number",
      "- step two",
      "  list:: number",
      "- step three about [[RRN Target]]",
      "  list:: number",
      "  - sub a",
      "    list:: number",
      "  - sub b",
      "    list:: number",
    ].join("\n"),
  );
  await page.goto(pagePath(target));
  const item = page.locator(".reference-item");
  await expect(item).toHaveCount(1);
  // Item three reads "3.", not "1.": its number counts its siblings on its own page.
  await expect(item.locator(".vr-list-number")).toHaveText(["3.", "1.", "2."]);
});
