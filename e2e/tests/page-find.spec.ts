/**
 * Find in page (audit §2 #16, B-232): Cmd/Ctrl+F on a page narrows the outline to matching blocks
 * and their ancestors, highlights the occurrences, and steps through them; Escape restores the
 * outline and the caret. Cmd/Ctrl+F anywhere else is left to the browser.
 *
 * The matching itself is unit-tested (`apps/web/src/editor/pageFilter.test.ts`); these tests are
 * about what only a real browser shows — the keymap claiming or not claiming the key, focus moving
 * between the bar and the editor, and the filter never writing to the page.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  editingRowIndex,
  editor,
  editorText,
  expectEditorFocusedNow,
  MOD,
  openEditing,
  openPage,
  readBlocks,
  rowTexts,
} from "../helpers/index.js";

function bar(page: Page): Locator {
  return page.locator(".page-find");
}

function input(page: Page): Locator {
  return page.locator(".page-find-input");
}

async function openFind(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+f`);
  await expect(input(page)).toBeFocused();
}

/** How many ranges each find highlight holds right now — the CSS Custom Highlight registry is the
 * only place the in-text highlight exists (it never touches the row DOM). */
async function highlightSizes(page: Page): Promise<{ all: number; current: number }> {
  return page.evaluate(() => ({
    all: CSS.highlights.get("nooklet-find")?.size ?? 0,
    current: CSS.highlights.get("nooklet-find-current")?.size ?? 0,
  }));
}

/** A page name of this run's own. The tests below edit their page, and `seedPage` returns an
 * existing page as it is, so under `--repeat-each` (or a retry) the second run found the first
 * run's edits instead of its seed and failed. */
function runName(base: string): string {
  const info = test.info();
  return `${base} ${info.repeatEachIndex}-${info.retry}`;
}

const NESTED = [
  "- Zahrada",
  "  - řeka a most",
  "  - nothing here",
  "- collapsed parent",
  "  collapsed:: true",
  "  - Reka under a collapsed block",
  "- unrelated",
].join("\n");

test("Cmd/Ctrl+F narrows the outline to matches and their ancestors, and Escape puts it back", async ({
  page,
}) => {
  const outliner = await openPage(page, "Find Narrows", NESTED);
  await expect(outliner.locator(".vr-row")).toHaveCount(5);

  await openFind(page);
  // Diacritics and case are ignored: "reka" finds both "řeka" and "Reka".
  await page.keyboard.type("reka");
  await expect
    .poll(() => rowTexts(page, outliner))
    .toEqual(["Zahrada", "řeka a most", "collapsed parent", "Reka under a collapsed block"]);
  await expect(outliner.locator(".vr-row-find-match")).toHaveCount(2);
  await expect(outliner.locator(".vr-row-find-context")).toHaveCount(2);
  await expect(bar(page).locator(".page-find-count")).toHaveText("1 of 2");
  await expect.poll(() => highlightSizes(page)).toEqual({ all: 1, current: 1 });

  await page.keyboard.type("xyz");
  await expect(bar(page).locator(".page-find-count")).toHaveText("No matches");
  await expect(outliner.locator(".vr-row")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  // The whole outline again, and the collapsed block still collapsed: the filter wrote nothing.
  await expect(outliner.locator(".vr-row")).toHaveCount(5);
  await expect.poll(() => highlightSizes(page)).toEqual({ all: 0, current: 0 });
  const stored = await api<{ text: string }>(page, "page.read", { page: "Find Narrows" });
  expect(stored.text).toContain("collapsed:: true");
});

test("Enter and Shift+Enter step through the matches", async ({ page }) => {
  await openPage(page, "Find Steps", "- apple one\n- pear\n- apple two\n- apple three");
  await openFind(page);
  await page.keyboard.type("apple");
  const count = bar(page).locator(".page-find-count");
  await expect(count).toHaveText("1 of 3");
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 3");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("3 of 3");
  await expect.poll(() => highlightSizes(page)).toEqual({ all: 2, current: 1 });
  // Focus never left the input.
  await expect(input(page)).toBeFocused();
});

test("from the editor: keys typed into the bar never reach the block, and Escape returns the caret", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Find From Editor", "- alpha beta\n- gamma");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  expect(await caret(page)).toEqual({ anchor: 5, head: 5 });

  await openFind(page);
  // Editing ended: a tree still editing would have run Enter as `block.split` on "alpha beta".
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.type("gam");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["gamma"]);
  const blocks = await readBlocks(page, "Find From Editor");
  expect(blocks.map((b) => [b.content, b.depth])).toEqual([
    ["alpha beta", 0],
    ["gamma", 0],
  ]);

  await input(page).focus();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expectEditorFocusedNow(page, "after Escape closed the find bar");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  expect(await caret(page)).toEqual({ anchor: 5, head: 5 });
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("alpha! beta");
});

test("a match can be edited while the filter stays, and typing it out of matching keeps its row", async ({
  page,
}) => {
  const name = runName("Find Then Edit");
  const outliner = await openPage(page, name, "- keep me\n- other\n- keep too");
  await openFind(page);
  await page.keyboard.type("keep");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await outliner.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("changed");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect(editor(page)).toHaveText("changed");

  // Cmd/Ctrl+F again takes the keyboard back, query selected, editing ended.
  await openFind(page);
  await expect(editor(page)).toHaveCount(0);
  expect(
    await input(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 4]);
  await expect
    .poll(async () => (await readBlocks(page, name))[0]?.content)
    .toBe("changed");
  // The edited block no longer matches and is no longer being edited, so it drops out.
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["keep too"]);
});

test("following a link from a filtered page closes the bar", async ({ page }) => {
  await api(page, "page.create", {
    name: "Find Link Target",
    if_exists: "return",
    markdown: "- here",
  });
  const outliner = await openPage(page, "Find Link Source", "- see [[Find Link Target]]\n- other");
  await openFind(page);
  await page.keyboard.type("see");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await outliner.locator(".vr-page-ref").first().click();
  await expect(page).toHaveURL(/Find%20Link%20Target/);
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
});

test("Cmd/Ctrl+F is left to the browser where there is no page to search", async ({ page }) => {
  const seen = async (): Promise<Array<{ prevented: boolean }>> =>
    page.evaluate(
      () => (window as unknown as { findKeys: Array<{ prevented: boolean }> }).findKeys,
    );
  const listen = async (): Promise<void> => {
    await page.evaluate(() => {
      const w = window as unknown as { findKeys: Array<{ prevented: boolean }> };
      w.findKeys = [];
      // Bubble phase on window: the app's keymap dispatches in the capture phase on document and
      // stops propagation of a key it handles, so a key that arrives here unprevented is one the
      // browser still gets to act on.
      window.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "f") w.findKeys.push({ prevented: e.defaultPrevented });
      });
    });
  };

  for (const path of ["/journals", "/search", "/pages"]) {
    await page.goto(path);
    await expect(page.locator(".app-topbar")).toBeVisible();
    await listen();
    await page.keyboard.press(`${MOD}+f`);
    expect(await seen(), `Cmd/Ctrl+F on ${path}`).toEqual([{ prevented: false }]);
    await expect(bar(page)).toHaveCount(0);
  }

  // …and on a page it is the app's.
  await openPage(page, "Find Claims Key", "- one");
  await listen();
  await page.keyboard.press(`${MOD}+f`);
  await expect(input(page)).toBeFocused();
  expect(await seen()).toEqual([]);
});

test("under a filter, Backspace and Delete join a block with its neighbour on the page, not the next match", async ({
  page,
}) => {
  // Merging uses reading order. With the filter's rows as that order, the "previous row" of a
  // match can be many hidden blocks away, and Backspace moved its text above blocks it never
  // touched: this page became "keep mekeep too" / "hidden one" / "hidden two" (probe, 2026-09-13).
  const name = runName("Find Merge Neighbours");
  const outliner = await openPage(page, name, "- keep me\n- hidden one\n- hidden two\n- keep too");
  await openFind(page);
  await page.keyboard.type("keep");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["keep me", "hidden one", "hidden twokeep too"]);

  await outliner.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["keep mehidden one", "hidden twokeep too"]);
});

test("closing the bar with its button leaves the caret in the block being edited", async ({
  page,
}) => {
  // The bar remembers where the caret was when it opened, for Escape to put back. A click on the
  // close button while editing ANOTHER block used that too, and the caret jumped away from where
  // the person was typing (probe, 2026-09-13).
  const outliner = await openPage(
    page,
    "Find Close Keeps Caret",
    "- alpha one\n- beta\n- alpha two",
  );
  await outliner.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await openFind(page);
  await page.keyboard.type("alpha");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");

  await bar(page).locator('[aria-label="Close find"]').click();
  await expect(bar(page)).toHaveCount(0);
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await expectEditorFocusedNow(page, "after the close button");
  expect(await editingRowIndex(page, outliner)).toBe(2);
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("alpha two!");
});

test("Escape puts the caret back in the same place in a block that shows a property line (B-361)", async ({
  page,
}) => {
  // The editor shows `list:: number` as line 2 of the block (B-101). The caret saved on open was an
  // offset into that buffer, and Escape put it back as if it were an offset into the text — the
  // property line's length further along.
  const name = runName("Find Property Caret");
  const outliner = await openPage(page, name, "- first line\n  list:: number\n  second line here");
  await outliner.locator(".vr-block-view").first().click();
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => editorText(page)).toBe("first line\nlist:: number\nsecond line here");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  for (let i = 0; i < " line here".length; i++) await page.keyboard.press("ArrowLeft");
  const afterSecond = "first line\nlist:: number\nsecond".length;
  expect(await caret(page)).toEqual({ anchor: afterSecond, head: afterSecond });

  await openFind(page);
  await expect(editor(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(await caret(page)).toEqual({ anchor: afterSecond, head: afterSecond });
  await page.keyboard.type("!");
  await expect
    .poll(async () => (await readBlocks(page, name))[0]?.content)
    .toBe("first line\nsecond! line here");
});
