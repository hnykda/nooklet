/**
 * The caret survives the row being edited MOVING in the DOM — in WebKit, the Mac app's engine
 * (B-501, B-502). Runs in both projects (`playwright.config.ts` adds it to the webkit testMatch).
 *
 * A keyed `<For>` reorders by moving the row's node, which takes focus off the editor; the tree
 * refocuses it (`BlockTree.tsx#refocusAfterReorder` → `surface.focus()`). Chromium fires `blur` on
 * the move, CodeMirror drops its cached DOM selection, and its focus writes the caret back. WebKit
 * fires no `blur`: CodeMirror keeps the stale cache, its focus writes nothing, and WebKit's focus
 * has put the DOM caret at the start of the block — which the next `selectionchange` reads into
 * the editor. Measured before the fix (probe `tools/probes/edited-row-move-mechanism.spec.ts`):
 * WebKit head 44 → 0 after the move, the next key typed at the START of the block, the `[[` popup
 * left open over a caret that had left its trigger; Chromium kept 46.
 *
 * Two ways to move the edited row: another device moving the block while you pause mid-link (a
 * sync refresh — the owner's B-42 report is a refresh with the `[[` popup open in the Mac app),
 * and Alt+Up on the block itself.
 */

import { expect, test } from "@playwright/test";
import {
  api,
  caret,
  clickRow,
  editingRowIndex,
  editorText,
  MOD,
  openEditing,
  readBlocks,
  rowTexts,
} from "../helpers/index.js";

test("another device moving the block you are typing a link into keeps the caret and the popup (B-502)", async ({
  page,
  browserName,
}) => {
  // Per engine: both projects share one server, and the first run leaves this page moved.
  const name = `Moved While Editing ${browserName}`;
  const outliner = await openEditing(page, name, "- above\n- base");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.type(" testing [[dru", { delay: 30 });
  await expect(page.locator(".cmd-popup")).toBeVisible();
  // Our own text write is on the server first, so the move below is the only refresh in play.
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["above", "base testing [[dru"]);
  const blocks = await readBlocks(page, name);
  const [above, base] = [blocks[0]?.id, blocks[1]?.id];
  const end = "base testing [[dru".length;
  expect(await caret(page)).toEqual({ anchor: end, head: end });

  await api(page, "block.move", { id: base, ref: above, position: "before" });
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["base testing [[dru", "above"]);
  expect(await editingRowIndex(page, outliner)).toBe(0);
  // The refocus is a microtask and the selectionchange that used to move the caret is async.
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await caret(page)).toEqual({ anchor: end, head: end });

  await page.keyboard.type("g");
  await expect.poll(() => editorText(page)).toBe("base testing [[drug");
  await expect(page.locator(".cmd-popup")).toBeVisible();
});

test("Alt+Up moves the block being edited without moving the caret (B-501)", async ({
  page,
  browserName,
}) => {
  const outliner = await openEditing(page, `Alt Up Caret ${browserName}`, "- one\n- two");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["two", "one"]);
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await caret(page)).toEqual({ anchor: 3, head: 3 });
  await page.keyboard.type("X");
  await expect.poll(() => editorText(page)).toBe("twoX");
});

// A guard, not a reproduction: this one passed in WebKit before the fix too (undo places the caret
// itself after the reorder). It covers the fix's riskiest caller — a refocus after a move whose
// caret the undo, not the user, decided.
test("undoing Alt+Up moves the block back without moving the caret (B-501)", async ({
  page,
  browserName,
}) => {
  const outliner = await openEditing(page, `Alt Up Undo Caret ${browserName}`, "- one\n- two");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["two", "one"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "two"]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await caret(page)).toEqual({ anchor: 2, head: 2 });
  await page.keyboard.type("X");
  await expect.poll(() => editorText(page)).toBe("twXo");
});

// The fix writes the caret through `EditorView.domAtPos`, and the live preview hides `[[`/`]]`/`**`
// away from the caret, so DOM offsets and document offsets differ on this line. The caret must come
// back mid-line, between the same two characters.
test("Alt+Up keeps a mid-line caret on a line with hidden link and bold markers (B-501)", async ({
  page,
  browserName,
}) => {
  const name = `Alt Up Mid Line ${browserName}`;
  const outliner = await openEditing(page, name, "- one\n- see [[Linked]] and **bold** words here");
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  const before = await caret(page);
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => editingRowIndex(page, outliner)).toBe(0);
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await caret(page)).toEqual(before);
  await page.keyboard.type("X");
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["see [[Linked]] and **bold** words Xhere", "one"]);
});
