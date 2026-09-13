/**
 * Block properties in the outliner: numbered lists (`list:: number`, B-100), property chips under a
 * block and its `key:: value` lines while editing (B-101), and `/property` writing a property the
 * server can see.
 *
 * All three were dead for the same reason — the client tree never carried a block's generic
 * properties — and every unit test passed anyway, because none of them looked at a rendered row
 * seeded through the real server. What the server stores is read back through `page.read`, never
 * from the DOM alone: the live preview hides markup while editing.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, openPage } from "../helpers/index.js";

interface ReadNode {
  id: string;
  content: string;
  properties?: Record<string, string>;
  children?: ReadNode[];
}

/** `page.read`'s blocks, flattened, with their properties. */
async function readWithProps(
  page: Page,
  name: string,
): Promise<Array<{ content: string; properties: Record<string, string> }>> {
  const out = await api<{ tree?: ReadNode[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<{ content: string; properties: Record<string, string> }> = [];
  const walk = (nodes: ReadNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push({ content: n.content, properties: n.properties ?? {} });
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

test.describe("numbered lists (B-100)", () => {
  test("list:: number siblings render 1, 2 and restart after a plain bullet", async ({ page }) => {
    const outliner = await openPage(
      page,
      "Props Numbered",
      [
        "- one",
        "  list:: number",
        "- two",
        "  list:: number",
        "  - nested plain",
        "  - nested one",
        "    list:: number",
        "- plain",
        "- again",
        "  list:: number",
      ].join("\n"),
    );
    const rows = outliner.locator(".vr-row");
    await expect(rows).toHaveCount(6);
    // One ordinal per numbered row, in row order: the run under `two` is its own sibling group,
    // and `plain` resets the top-level run.
    const numbers = await rows.evaluateAll((els) =>
      els.map((r) => r.querySelector(".vr-list-number")?.textContent ?? null),
    );
    expect(numbers).toEqual(["1.", "2.", null, "1.", null, "1."]);
    // The ordinal is the marker, so `list:: number` itself is not repeated as a chip.
    await expect(outliner.locator(".vr-block-props")).toHaveCount(0);
  });

  test("a literal `1.` bullet imported through page.create numbers too", async ({ page }) => {
    const outliner = await openPage(page, "Props Numbered Literal", "1. first\n2. second");
    await expect(outliner.locator(".vr-list-number")).toHaveText(["1.", "2."]);
  });
});
