/**
 * Backspace at the start of a block and Delete at the end of one merge two blocks (R20/R21). The
 * block that disappears used to take its task marker, dates and properties with it (B-340): only
 * the two contents were joined. These read what the SERVER stored after the merge, through
 * `page.read`, since the live preview hides markup and a local tree can look right before a sync.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, clickAway, clickRow, editorText, MOD, openPage } from "../helpers/index.js";

interface Node {
  content: string;
  marker?: string | null;
  properties?: Record<string, string>;
  children?: Node[];
}

/** Each stored block as `[content, marker, properties]`, in reading order. */
async function stored(page: Page, name: string): Promise<Array<[string, string | null, object]>> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<[string, string | null, object]> = [];
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push([n.content, n.marker ?? null, n.properties ?? {}]);
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

test("Backspace keeps the merged block's TODO, scheduled date and properties, also from an empty block (B-340)", async ({
  page,
}) => {
  const name = "Merge Carry Backspace";
  const outliner = await openPage(
    page,
    name,
    [
      "- notes here",
      "- TODO buy milk",
      "  scheduled:: 2026-09-20",
      "  owner:: dan",
      "- plain",
      "- ",
      "  list:: number",
      "  source:: book",
      "- last",
    ].join("\n"),
  );
  await expect(outliner.locator(".vr-row")).toHaveCount(5);

  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("Backspace");
  await expect(outliner.locator(".vr-row")).toHaveCount(4);

  // Row 2 is now the empty numbered block; its buffer is `\nlist:: number\nsource:: book`.
  await clickRow(page, outliner, 2);
  expect(await editorText(page)).toBe("\nlist:: number\nsource:: book");
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("Backspace");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await clickAway(page);

  await expect
    .poll(() => stored(page, name))
    .toEqual([
      ["notes herebuy milk", "TODO", { scheduled: "2026-09-20", owner: "dan" }],
      ["plain", null, { list: "number", source: "book" }],
      ["last", null, {}],
    ]);
});

test("Delete at the end pulls in the next block's properties; a conflicting value refuses the merge with a notice (B-340)", async ({
  page,
}) => {
  const name = "Merge Carry Delete";
  const outliner = await openPage(
    page,
    name,
    [
      "- gamma",
      "- delta",
      "  list:: number",
      "  tag:: x",
      "- kept",
      "  owner:: alice",
      "- other",
      "  owner:: dan",
    ].join("\n"),
  );
  await expect(outliner.locator(".vr-row")).toHaveCount(4);

  await clickRow(page, outliner, 0);
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.press("Delete");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);

  // `kept` and `other` disagree about owner::, so neither value can go: nothing is merged.
  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.press("Delete");
  const notice = page.locator(".vr-readonly-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("owner:: (alice / dan)");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await clickAway(page);

  await expect
    .poll(() => stored(page, name))
    .toEqual([
      ["gammadelta", null, { list: "number", tag: "x" }],
      ["kept", null, { owner: "alice" }],
      ["other", null, { owner: "dan" }],
    ]);
});
