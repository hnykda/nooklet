/**
 * `/mermaid` typed at the end of a block that already has text (B-344). A fence renders only as the
 * first line of a block's content (`core/tokens.ts#classifyFence`), so inserted inline after
 * `after text` the starter was stored as one paragraph and no diagram was ever drawn. On a block with
 * text the starter now goes into a new block right after it, as `/template` does. Page names start
 * with "Mermaid After" — no other spec uses them.
 */
import { expect, test } from "@playwright/test";
import { clickAway, MOD, openEditing, readBlocks } from "../helpers/index.js";

const STARTER = "```mermaid\ngraph TD\n  A --> B\n```";

test("/mermaid after existing text puts the diagram in its own block, which renders (B-344)", async ({
  page,
}) => {
  const name = "Mermaid After Text";
  const outliner = await openEditing(page, name, "- after text\n- next one");
  await page.keyboard.type(" /merm");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toHaveText("Mermaid diagram");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);

  const stored = async () => (await readBlocks(page, name)).map((b) => b.content.trimEnd());
  await expect.poll(stored, { timeout: 15_000 }).toEqual(["after text", STARTER, "next one"]);

  // The caret is inside the new diagram, at the end of its last line, as on an empty block (B-185).
  await page.keyboard.type(" --> C");
  const extended = "```mermaid\ngraph TD\n  A --> B --> C\n```";
  await expect.poll(stored, { timeout: 15_000 }).toEqual(["after text", extended, "next one"]);

  await clickAway(page);
  const diagram = outliner.locator(".vr-row").nth(1).locator(".vr-plugin-fence svg");
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toContainText("C");
  await expect(outliner.locator(".vr-row").nth(0)).toContainText("after text");
});

test("undo takes the inserted diagram block back in one step (B-344)", async ({ page }) => {
  const name = "Mermaid After Undo";
  await openEditing(page, name, "- before undo");
  await page.keyboard.type(" /merm");
  const popup = page.locator(".cmd-popup");
  await expect(popup.locator(".cmd-row--active")).toHaveText("Mermaid diagram");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  const stored = async () => (await readBlocks(page, name)).map((b) => b.content.trimEnd());
  await expect.poll(stored, { timeout: 15_000 }).toEqual(["before undo", STARTER]);

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(stored, { timeout: 15_000 }).toEqual(["before undo"]);
});
