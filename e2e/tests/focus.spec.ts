/**
 * Focus and keystrokes: the place this app has broken most often (docs/BUGS.md B-02, B-03, B-06,
 * B-07, B-15, B-16, B-42). Every structural key re-renders the row being edited, and every one of
 * those re-renders is a chance for focus to fall to `<body>` and for the next keystrokes to vanish.
 *
 * So after every operation that can re-render, focus is checked SYNCHRONOUSLY (`pressWatchingFocus`
 * / `expectEditorFocusedNow`), and text typed immediately afterwards — no delay, no waiting for a
 * retrying matcher — has to land where a person would expect it.
 */

import { expect, test } from "@playwright/test";
import {
  api,
  caret,
  clickAway,
  clickRow,
  editingRowIndex,
  editor,
  editorText,
  expectEditorFocusedNow,
  MOD,
  openEditing,
  openPage,
  pagePath,
  pressWatchingFocus,
  readBlocks,
  rowDepths,
  rowTexts,
  seedPage,
  typeWatchingFocus,
} from "../helpers/index.js";

test("typing immediately after clicking a block loses nothing", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Click Type", "- start\n- other");
  // No `toBeFocused()` between the click and the typing: the point is what happens in the frame
  // after the click, which a retrying matcher would wait out (B-15). Twice, so the second click
  // lands on a row that was rendered as a view AFTER holding the editor.
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await page.keyboard.press("End");
  await page.keyboard.type("+abc");
  await outliner.locator(".vr-row").nth(0).locator(".vr-block-view").click();
  await page.keyboard.press("End");
  await page.keyboard.type("+def");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["start+def", "other+abc"]);
});

test("every character of a long sentence typed without delay lands", async ({ page }) => {
  await openEditing(page, "Focus Long Sentence", "- ");
  const sentence =
    "the quick brown fox jumps over the lazy dog, twice, and then once more for luck";
  await page.keyboard.type(sentence);
  await expect(editor(page)).toHaveText(sentence);
  await expectEditorFocusedNow(page, "after typing a long sentence");
});

test("Enter at the end creates a focused sibling and typing lands in it", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Enter End", "- start");
  const losses = await pressWatchingFocus(page, ["Enter"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await page.keyboard.type("beta");

  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await rowTexts(page, outliner)).toEqual(["start", "beta"]);
});

test("Enter in the middle of a block splits the text and puts the caret at the start of the new block", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Enter Split", "- hello world");
  for (let i = 0; i < "world".length; i++) await page.keyboard.press("ArrowLeft");
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });

  await page.keyboard.press("Enter");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await caret(page)).toEqual({ anchor: 0, head: 0 });
  await page.keyboard.type("X");
  // Polled: a refetch that started before the split can resolve after it and briefly show the
  // first row's pre-split text again before the next refetch corrects it.
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["hello ", "Xworld"]);
});

test("Enter on an expanded parent inserts the new block as its first child (R16)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Enter Parent", "- parent\n  - child");
  await page.keyboard.press("Enter");
  await page.keyboard.type("new");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  expect(await rowTexts(page, outliner)).toEqual(["parent", "new", "child"]);
  expect(await rowDepths(page, outliner)).toEqual([0, 1, 1]);
});

test("Enter on an empty block keeps making empty siblings, each one focused", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Enter Empty", "- start");
  const losses = await pressWatchingFocus(page, ["Enter", "Enter", "Enter"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect(outliner.locator(".vr-row")).toHaveCount(4);
  expect(await editingRowIndex(page, outliner)).toBe(3);
});

test("Shift+Enter inserts a newline inside the block, not a new block (R17)", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Shift Enter", "- line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  expect(await editorText(page)).toBe("line one\nline two");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);

  await page.reload();
  const reloaded = page.locator(".vr-outliner").first();
  await expect(reloaded.locator(".vr-row")).toHaveCount(1);
  await expect(reloaded.locator(".vr-block-view").first()).toContainText("line two");
});

test("Tab and Shift+Tab keep focus and the caret where they were (R18/R19)", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Tab Caret", "- first\n- second");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });

  let losses = await pressWatchingFocus(page, ["Tab"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 1]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });

  losses = await pressWatchingFocus(page, ["Shift+Tab"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect.poll(() => rowDepths(page, outliner)).toEqual([0, 0]);
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });

  // And it is still a working editor afterwards.
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("second!");
});

test("Tab on the first block is a no-op that keeps the editor usable", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Tab First", "- only");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await rowDepths(page, outliner)).toEqual([0]);
  await expectEditorFocusedNow(page, "after a no-op Tab");
  await page.keyboard.type("x");
  await expect(editor(page)).toHaveText("onlyx");
});

test("Arrow Down and Arrow Up move between blocks without dropping focus (R23)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Arrows", "- alpha\n- beta\n- gamma");
  await clickRow(page, outliner, 0);

  let losses = await pressWatchingFocus(page, ["ArrowDown"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  expect(await editingRowIndex(page, outliner)).toBe(1);

  losses = await pressWatchingFocus(page, ["ArrowDown", "ArrowUp", "ArrowUp"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  expect(await editingRowIndex(page, outliner)).toBe(0);

  // Up on the first block stays put rather than losing the editor.
  await page.keyboard.press("ArrowUp");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  await expectEditorFocusedNow(page, "after ArrowUp on the first block");
});

test("Arrow Right at the end and Arrow Left at the start cross block boundaries (R24)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Arrow Char", "- ab\n- cd");
  await page.keyboard.press("ArrowRight");
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await caret(page)).toEqual({ anchor: 0, head: 0 });

  await page.keyboard.press("ArrowLeft");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  expect(await caret(page)).toEqual({ anchor: 2, head: 2 });
  await expectEditorFocusedNow(page, "after crossing back with ArrowLeft");
});

test("Backspace at the start merges into the previous block with the caret at the join (R20)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Backspace Merge", "- hello\n- world");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("Home");
  const losses = await pressWatchingFocus(page, ["Backspace"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);

  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(editor(page)).toHaveText("helloworld");
  expect(await caret(page)).toEqual({ anchor: 5, head: 5 });
  await page.keyboard.type(" ");
  await expect(editor(page)).toHaveText("hello world");
});

test("Backspace on an empty block deletes it and focuses the previous block at its end", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Backspace Empty", "- keep");
  await page.keyboard.press("Enter");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  const losses = await pressWatchingFocus(page, ["Backspace"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  expect(await editingRowIndex(page, outliner)).toBe(0);
  expect(await caret(page)).toEqual({ anchor: 4, head: 4 });
});

test("Backspace at the start of the first block does nothing destructive", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Backspace First", "- solo");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(editor(page)).toHaveText("solo");
  await expectEditorFocusedNow(page, "after Backspace at the start of the first block");
});

test("Delete at the end merges the next block in, keeping the caret (R21)", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Delete Merge", "- ab\n- cd");
  await page.keyboard.press("Delete");
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(editor(page)).toHaveText("abcd");
  expect(await caret(page)).toEqual({ anchor: 2, head: 2 });
  await expectEditorFocusedNow(page, "after Delete-merge");
  // What is on screen is what is stored — typing afterwards must build on the merged text.
  await page.keyboard.type("X");
  await expect
    .poll(async () => (await readBlocks(page, "Focus Delete Merge")).map((b) => b.content))
    .toEqual(["abXcd"]);
});

test("clicking away commits the text and clicking back re-enters at the click point", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Away Back", "- some text\n- other");
  await page.keyboard.type(" more");
  await clickAway(page);
  // The blur committed it: the block reads the same from a fresh load.
  await expect
    .poll(async () => (await readBlocks(page, "Focus Away Back")).map((b) => b.content))
    .toEqual(["some text more", "other"]);

  // Move the editor to the sibling so the first row renders as a view again, then click at the
  // far left of it: the caret lands at offset 0, not at the end.
  await clickRow(page, outliner, 1);
  const view = outliner.locator(".vr-row").nth(0).locator(".vr-block-view");
  await expect(view).toHaveText("some text more");
  await view.click({ position: { x: 2, y: 8 } });
  await expectEditorFocusedNow(page, "after clicking back into the block");
  expect(await caret(page)).toEqual({ anchor: 0, head: 0 });
  await page.keyboard.type("X");
  await expect(editor(page)).toHaveText("Xsome text more");
});

test("clicking inside a word puts the caret at that character, not at the end", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Click Offset", "- abcdefghij\n- other");
  await clickRow(page, outliner, 1);
  const view = outliner.locator(".vr-row").nth(0).locator(".vr-block-view");
  // Anywhere strictly inside the text must not resolve to the end.
  const box = await view.locator("[data-from]").first().boundingBox();
  expect(box).not.toBeNull();
  await view.click({ position: { x: Math.round((box?.width ?? 20) * 0.5), y: 8 } });
  await expectEditorFocusedNow(page, "after clicking mid-word");
  const c = await caret(page);
  expect(c.head).toBeGreaterThan(0);
  expect(c.head).toBeLessThan(10);
});

test("Cmd/Ctrl+A selects exactly the block's text", async ({ page }) => {
  await openEditing(page, "Focus Select All", "- select me");
  await page.keyboard.press(`${MOD}+a`);
  const c = await caret(page);
  expect(Math.min(c.anchor, c.head)).toBe(0);
  expect(Math.max(c.anchor, c.head)).toBe("select me".length);
  await expectEditorFocusedNow(page, "after select-all");
});

test("Alt+Up/Down moves the block and keeps the editor in it (R22)", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Move", "- one\n- two");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");

  let losses = await pressWatchingFocus(page, ["Alt+ArrowUp"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["two", "one"]);
  expect(await editingRowIndex(page, outliner)).toBe(0);
  expect(await caret(page)).toEqual({ anchor: 3, head: 3 });

  losses = await pressWatchingFocus(page, ["Alt+ArrowDown"]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "two"]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
});

test("Cmd/Ctrl+Shift+D duplicates the block and focuses the copy (R32)", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Duplicate", "- dup me\n  - kid");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("End");
  const losses = await pressWatchingFocus(page, [`${MOD}+Shift+d`]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect(outliner.locator(".vr-row")).toHaveCount(4);
  expect(await rowTexts(page, outliner)).toEqual(["dup me", "kid", "dup me", "kid"]);
  expect(await editingRowIndex(page, outliner)).toBe(2);
  expect(await caret(page)).toEqual({ anchor: 6, head: 6 });
});

test("Cmd/Ctrl+Up collapses a parent and Cmd/Ctrl+Down expands it, focus intact (R25)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Collapse", "- parent\n  - child");
  await clickRow(page, outliner, 0);
  const losses = await pressWatchingFocus(page, [`${MOD}+ArrowUp`]);
  expect(losses, JSON.stringify(losses)).toEqual([]);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(outliner.locator(".vr-child-count")).toHaveText("1");

  await page.keyboard.press(`${MOD}+ArrowDown`);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expectEditorFocusedNow(page, "after expanding");
});

test("Cmd/Ctrl+. zooms into the block and Cmd/Ctrl+Shift+. zooms back out (R27)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Zoom Keys", "- top\n  - inner\n- other");
  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+.`);
  const trail = page.locator(".vr-zoom-trail");
  await expect(trail).toBeVisible();
  await expect(trail.locator(".vr-crumb-current")).toHaveText("inner");
  await expect(trail.locator(".vr-crumb")).toHaveText(["Focus Zoom Keys", "top"]);
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(1);

  await page.keyboard.press(`${MOD}+Shift+.`);
  await expect(trail.locator(".vr-crumb-current")).toHaveText("top");
  await page.keyboard.press(`${MOD}+Shift+.`);
  await expect(trail).toHaveCount(0);
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(3);
});

test("Cmd/Ctrl+Z undoes typed text and Cmd/Ctrl+Shift+Z redoes it", async ({ page }) => {
  await openEditing(page, "Focus Undo", "- base");
  await page.keyboard.type(" typed");
  await expect(editor(page)).toHaveText("base typed");

  await page.keyboard.press(`${MOD}+z`);
  await expect(editor(page)).toHaveText("base");
  await expect
    .poll(async () => (await readBlocks(page, "Focus Undo")).map((b) => b.content))
    .toEqual(["base"]);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(editor(page)).toHaveText("base typed");
  await expectEditorFocusedNow(page, "after undo/redo");
});

test("undo reverts a structural change (Enter) and focus follows it back", async ({ page }) => {
  const outliner = await openEditing(page, "Focus Undo Structure", "- first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await page.keyboard.press(`${MOD}+z`); // the typed text
  await page.keyboard.press(`${MOD}+z`); // the split
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect(outliner).toContainText("first");
  await expect(outliner).not.toContainText("second");
});

test("text typed just before an in-app navigation is not lost", async ({ page }) => {
  await openEditing(page, "Focus Nav Flush", "- keep");
  await page.keyboard.type(" me");
  // Inside the 500 ms write debounce, leave through a keyboard route change — no click, so no
  // blur to flush on. The tree unmounts; the pending edit must still reach the database.
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(page).toHaveURL(/\/search/);

  await page.goto(pagePath("Focus Nav Flush"));
  await expect(page.locator(".vr-outliner").first()).toContainText("keep me");
});

test("the same text also survives a reload started inside the debounce window", async ({
  page,
}) => {
  await openEditing(page, "Focus Reload Flush", "- keep");
  await page.keyboard.type(" too");
  await page.reload();
  await expect(page.locator(".vr-outliner").first()).toContainText("keep too");
});

test("clicking a [[link]] in a rendered block navigates instead of entering edit mode", async ({
  page,
}) => {
  await seedPage(page, "Focus Link Dst", "- destination");
  const outliner = await openPage(page, "Focus Link Src", "- go to [[Focus Link Dst]]");
  await outliner.locator(".vr-page-ref").first().click();
  await expect(page).toHaveURL(/\/page\/Focus%20Link%20Dst/);
  await expect(page.locator(".cm-content")).toHaveCount(0);
  await expect(page.locator(".vr-outliner").first()).toContainText("destination");
});

test("a keystroke-by-keystroke trace of plain typing records no focusout at all", async ({
  page,
}) => {
  await openEditing(page, "Focus Plain Trace", "- ");
  const losses = await typeWatchingFocus(page, "plain words, no triggers here");
  expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
});

test("Escape while editing hands the block to selection mode and Enter hands it back", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Escape Enter", "- pick me");
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  await expect(editor(page)).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(1);
  await expectEditorFocusedNow(page, "after Enter from selection mode");
  expect(await caret(page)).toEqual({ anchor: 7, head: 7 });
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(0);
});

test("an edit made through the API while a different block is being edited does not steal focus", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Focus Remote Edit", "- mine\n- theirs");
  await clickRow(page, outliner, 0);
  await page.keyboard.press("End");
  // Another device (an agent) appends a block while the caret is in the first one.
  await api(page, "page.append", { page: "Focus Remote Edit", markdown: "- from an agent" });
  await expect(outliner.locator(".vr-row")).toHaveCount(3, { timeout: 15_000 });
  await expectEditorFocusedNow(page, "after a remote block arrived");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("mine!");
});
