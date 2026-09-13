/**
 * Document-level undo/redo against the real server (ADR 006, `apps/web/src/editor/history.ts`).
 *
 * `focus.spec.ts` covers undo of typed text and of one split, looking at the screen. What these
 * tests add is the other half: after every undo and redo the SERVER has to agree with the screen,
 * and a reload has to show the same thing. Exploratory QA on 2026-09-13 found three ways the two
 * came apart: a redo the server ignored, an undo that went nowhere, an undo that dropped focus.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clickAway,
  clickRow,
  expectEditorFocusedNow,
  MOD,
  openEditing,
  readBlocks,
  rowTexts,
} from "../helpers/index.js";

async function stored(page: Page, name: string): Promise<string[]> {
  return (await readBlocks(page, name)).map((b) => b.content);
}

test("redo of an undone Enter puts the block back on the server, not just on screen (B-240)", async ({
  page,
}) => {
  const name = "Undo Redo Create";
  const outliner = await openEditing(page, name, "- one\n- two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("mid");
  await expect.poll(() => stored(page, name)).toEqual(["one", "mid", "two"]);

  await page.keyboard.press(`${MOD}+z`); // the typed text
  await page.keyboard.press(`${MOD}+z`); // the split: the new block is tombstoned
  await expect.poll(() => stored(page, name)).toEqual(["one", "two"]);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);

  await page.keyboard.press(`${MOD}+Shift+z`); // the split again
  await page.keyboard.press(`${MOD}+Shift+z`); // the text again
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["one", "mid", "two"]);
  // The redo's block.create used to be a no-op on the server (the id already existed, as a
  // tombstone) while the client's optimistic layer revived it: screen and server disagreed.
  await expect.poll(() => stored(page, name)).toEqual(["one", "mid", "two"]);

  await page.reload();
  const rows = page.locator(".vr-outliner").first().locator(".vr-row");
  await expect(rows).toHaveCount(3);
  expect(await rowTexts(page)).toEqual(["one", "mid", "two"]);
});

for (const key of ["Delete", "Backspace"]) {
  test(`Cmd/Ctrl+Z right after ${key} on a block selection brings the blocks back (B-241)`, async ({
    page,
  }) => {
    const name = `Undo Selection ${key}`;
    const outliner = await openEditing(page, name, "- alpha\n- beta\n- gamma\n- delta");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);
    await page.keyboard.press(key);
    await expect.poll(() => stored(page, name)).toEqual(["gamma", "delta"]);
    await expect(outliner.locator(".vr-row")).toHaveCount(2);

    // Nothing is edited or selected any more. The undo used to reach an inert host and do
    // nothing, then fire much later, the next time a block of this page was being edited.
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => rowTexts(page, outliner)).toEqual(["alpha", "beta", "gamma", "delta"]);
    await expect.poll(() => stored(page, name)).toEqual(["alpha", "beta", "gamma", "delta"]);

    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(() => stored(page, name)).toEqual(["gamma", "delta"]);
    await expect(outliner.locator(".vr-row")).toHaveCount(2);
  });
}

test("Cmd/Ctrl+Z after clicking away still undoes the last edit on the page (B-241)", async ({
  page,
}) => {
  const name = "Undo After Click Away";
  const outliner = await openEditing(page, name, "- base");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect.poll(() => stored(page, name)).toEqual(["base", "second"]);
  await clickAway(page);

  await page.keyboard.press(`${MOD}+z`); // the typed text
  await page.keyboard.press(`${MOD}+z`); // the split
  await expect.poll(() => stored(page, name)).toEqual(["base"]);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
});

for (const [move, moved] of [
  ["Alt+ArrowDown", ["one", "three", "two"]],
  ["Alt+ArrowUp", ["two", "one", "three"]],
] as const) {
  test(`typing right after undoing or redoing ${move} lands in the moved block (B-242)`, async ({
    page,
  }) => {
    const name = `Undo Move Focus ${move}`;
    const outliner = await openEditing(page, name, "- one\n- two\n- three");
    await clickRow(page, outliner, 1);
    await page.keyboard.press("End");

    // The undo blurred the editor twice over. At once: the keyed <For> moves the edited row's DOM
    // node back (B-68 refocused after the move, not after its undo). Then, 10-50 ms later: a
    // refetch that read before the undo puts the old order back for a frame and the next one
    // restores it, two more moves. So type straight after the undo, as a person would, and again
    // once the refetches have landed.
    await page.keyboard.press(move);
    await expect.poll(() => rowTexts(page, outliner)).toEqual([...moved]);
    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.type("X");
    await page.waitForTimeout(400);
    await expectEditorFocusedNow(page, `400 ms after undoing ${move}`);
    await page.keyboard.type("Y");
    await expect.poll(() => stored(page, name)).toEqual(["one", "twoXY", "three"]);

    // Redo moves the row again: the same blurs, the same need to refocus.
    await page.keyboard.press(move);
    const movedWith = (text: string) => moved.map((t) => t.replace("two", text));
    await expect.poll(() => stored(page, name)).toEqual(movedWith("twoXY"));
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => stored(page, name)).toEqual(["one", "twoXY", "three"]);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await page.keyboard.type("Z");
    await page.waitForTimeout(400);
    await expectEditorFocusedNow(page, `400 ms after redoing ${move}`);
    await page.keyboard.type("W");
    await expect.poll(() => stored(page, name)).toEqual(movedWith("twoXYZW"));
  });
}
