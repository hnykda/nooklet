/**
 * B-606: in a block that ENDS with a `[[link]]`, clicking in the empty space right of the rendered
 * text, or pressing End, must put the caret AFTER the closing `]]`, so typing appends after the
 * link, as in Logseq. Before the fix both gestures put it inside the link and the next key changed
 * the link's target (`[[BaleníZ]]`), creating a junk page.
 *
 * Two causes, one per gesture. The rendered view mapped the click by rendered character from the
 * token's `data-from` (`caret.ts`), which for a link counts from the `[[` and never reaches the
 * `]]`. The editor's End hit-tests the editor's right edge (CM6 `moveToLineBoundary`), which never
 * lands past a zero-width hidden `]]` (`livePreview.ts`). Covered here for every token whose
 * closing markup is hidden or not rendered (`#[[multi word]]`, `**bold**`, `((block ref))`), a
 * link followed by a typed space, a click inside the editor itself, and Home before a LEADING
 * link. Clicking ON a link must still navigate.
 *
 * Page names start with "CAL " so they cannot collide with another spec's on the shared server.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, editor, editorText, openPage, readBlocks, runName } from "../helpers/index.js";

/** `base` made unique per project, repeat and retry: both engines run this file against one
 * server, and a page the other engine already typed into would start with its keystrokes. */
function unique(base: string): string {
  const info = test.info();
  return `${runName(base, info)} ${info.project.name}`;
}

/** Click the empty space right of row `index`'s text: its rendered view, or the editor when the
 * row is the one being edited. Both are full-width. */
async function clickRightOfText(page: Page, outliner: Locator, index: number): Promise<void> {
  const row = outliner.locator(".vr-row").nth(index);
  const view = row.locator(".vr-block-view");
  const target = (await view.count()) > 0 ? view : row.locator(".cm-content");
  const box = await target.boundingBox();
  if (!box) throw new Error("row has no box");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await expect(editor(page)).toBeFocused();
}

/** Leave edit mode and wait for the server to have `expected` as row `index`'s content. The
 * stored text is what is asserted, not the editor's DOM: with the caret after a link the editor
 * hides its `[[`/`]]`, so its rendered text is not the source. */
async function expectStored(page: Page, name: string, index: number, expected: string) {
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await readBlocks(page, name))[index]?.content, { timeout: 10_000 })
    .toBe(expected);
}

const CASES = ["plain text [[Balení]]", "#[[CAL multi word]]", "text **bold**"];

for (const content of CASES) {
  const slug = content.replace(/[^a-z]/gi, "");

  test(`clicking right of the text of "${content}" types after it (B-606)`, async ({ page }) => {
    const name = unique(`CAL Click ${slug}`);
    const outliner = await openPage(page, name, `- ${content}`);
    await clickRightOfText(page, outliner, 0);
    await page.keyboard.type("Y");
    await expectStored(page, name, 0, `${content}Y`);
  });

  test(`Home then End in "${content}" types after it (B-606)`, async ({ page }) => {
    const name = unique(`CAL End ${slug}`);
    const outliner = await openPage(page, name, `- ${content}`);
    await clickRightOfText(page, outliner, 0);
    // From the start, where the markers are hidden again: End alone decides where the caret goes.
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await page.keyboard.type("Z");
    await expectStored(page, name, 0, `${content}Z`);
  });

  test(`clicking right of "${content}" inside the editor types after it (B-606)`, async ({
    page,
  }) => {
    const name = unique(`CAL Editor Click ${slug}`);
    const outliner = await openPage(page, name, `- ${content}`);
    await clickRightOfText(page, outliner, 0);
    await page.keyboard.press("Home");
    // The row is now the editor, with the markers hidden; CM6's own hit test places this click.
    await clickRightOfText(page, outliner, 0);
    await page.keyboard.type("W");
    await expectStored(page, name, 0, `${content}W`);
  });
}

test("a link followed by a typed space: End types after the space (B-606)", async ({ page }) => {
  const name = unique("CAL Trailing Space");
  const outliner = await openPage(page, name, "- see [[CAL Target]]");
  await clickRightOfText(page, outliner, 0);
  await page.keyboard.type(" ");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.type("Z");
  await expectStored(page, name, 0, "see [[CAL Target]] Z");
});

test("a block ending in a ((block ref)): click right of it and End both type after it (B-606)", async ({
  page,
}) => {
  const name = unique("CAL Block Ref");
  await openPage(page, name, "- CAL ref target text\n- placeholder");
  const [target, second] = await readBlocks(page, name);
  if (!target || !second) throw new Error("seed missing");
  const content = `see ((${target.id}))`;
  await api(page, "block.update", { id: second.id, content });
  await page.reload();
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").nth(1).locator(".vr-block-ref")).toContainText(
    "CAL ref target text",
  );
  await clickRightOfText(page, outliner, 1);
  await page.keyboard.type("Y");
  await expect.poll(() => editorText(page)).toBe(`${content}Y`);
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.type("Z");
  await expect.poll(() => editorText(page)).toBe(`${content}YZ`);
  await expectStored(page, name, 1, `${content}YZ`);
});

test("Home before a leading [[link]] types before the [[ (B-606)", async ({ page }) => {
  const name = unique("CAL Home Leading");
  const content = "[[CAL Lead]] trailing words";
  const outliner = await openPage(page, name, `- ${content}`);
  await clickRightOfText(page, outliner, 0);
  await page.keyboard.press("Home");
  await page.keyboard.type("A");
  await expectStored(page, name, 0, `A${content}`);
});

test("clicking ON a trailing link still navigates to its page (B-606)", async ({ page }) => {
  const outliner = await openPage(
    page,
    unique("CAL Click On Link"),
    "- plain text [[CAL Nav Target]]",
  );
  await outliner.locator(".vr-row").first().locator("a.vr-page-ref").click();
  await expect(page).toHaveURL(/CAL%20Nav%20Target/);
});

test("walking back from after a trailing link still edits its target (B-606)", async ({ page }) => {
  const name = unique("CAL Walk Into Link");
  const outliner = await openPage(page, name, "- plain text [[CAL Walk]]");
  await clickRightOfText(page, outliner, 0);
  // After `]]` the link is revealed (the caret touches it): two steps cross `]]`, one more `k`.
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");
  await expect.poll(() => editorText(page)).toBe("plain text [[CAL WalXk]]");
});
