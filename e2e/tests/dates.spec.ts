/**
 * Dates end to end (B-96, B-102; spec R38; ADR 011): `/scheduled`, `/deadline` and "Set
 * scheduled date" open a keyboard-first picker that writes `scheduled::`/`deadline::` in ADR 011's
 * exact shape; the row shows the date as a chip, overdue open tasks styled so; clicking a chip
 * opens the same picker.
 *
 * Every assertion about what was stored reads the server (`page.read`), never the DOM: the chip
 * proving a write is the thing under test, so it cannot also be the evidence.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  caret,
  clickRow,
  editingRowIndex,
  editor,
  editorText,
  expectEditorFocusedNow,
  isoOffset,
  MOD,
  openEditing,
  openPage,
  readBlocks,
  rowDepths,
} from "../helpers/index.js";

interface Node {
  content: string;
  properties?: Record<string, string>;
  children?: Node[];
}

/** Each block's stored properties, in reading order. */
async function propsOf(page: Page, name: string): Promise<Array<Record<string, string>>> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<Record<string, string>> = [];
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push(n.properties ?? {});
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

function picker(page: Page): Locator {
  return page.locator(".date-picker");
}

function activeDay(page: Page): Locator {
  return picker(page).locator(".dp-day--active");
}

/** `YYYY-MM-DD` → the picker's `data-day` (`YYYYMMDD`). */
function dataDay(iso: string): string {
  return iso.replaceAll("-", "");
}

function chip(row: Locator, field: "scheduled" | "deadline"): Locator {
  return row.locator(`.vr-date[data-field="${field}"]`);
}

/** Type `/<item>` and take that slash-menu row with Enter. */
async function slash(page: Page, query: string, label: string): Promise<void> {
  await page.keyboard.type(` /${query}`);
  const menu = page.locator(".cmd-popup").first();
  await expect(menu).toBeVisible();
  await expect(menu.locator(".cmd-row--active")).toHaveText(label);
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
  // One popup for one question: the slash menu is gone once the picker is up.
  await expect(page.locator(".cmd-popup")).toHaveCount(1);
}

test("/scheduled, type tomorrow, Enter: scheduled:: is stored, the chip appears, the caret never left (B-96)", async ({
  page,
}) => {
  // Not a TODO on purpose: the whole e2e run shares one graph, and `query.spec.ts` counts the
  // open tasks scheduled for tomorrow. Any block can carry a date (ADR 011).
  const outliner = await openEditing(page, "Dates Slash Scheduled", "- call mom");
  await slash(page, "sched", "Scheduled");
  await expectEditorFocusedNow(page, "while the picker is open");

  await page.keyboard.type("tomorrow");
  await expect(picker(page).locator(".dp-text")).toHaveText("tomorrow");
  await expect(activeDay(page)).toHaveAttribute("data-day", dataDay(isoOffset(1)));
  await page.keyboard.press("Enter");

  await expect(picker(page)).toHaveCount(0);
  await expectEditorFocusedNow(page, "after the picker set the date");
  // The trigger went, and not one of the keys typed into the picker reached the block.
  expect(await editorText(page)).toBe("call mom ");
  await expect
    .poll(async () => (await propsOf(page, "Dates Slash Scheduled"))[0]?.scheduled)
    .toBe(isoOffset(1));
  const row = outliner.locator(".vr-row").first();
  await expect(chip(row, "scheduled")).toHaveText("Tomorrow");
  await expect(chip(row, "scheduled")).toHaveAttribute("data-value", isoOffset(1));

  // Typing goes on in the block as if nothing had happened.
  await page.keyboard.type("today");
  expect(await editorText(page)).toBe("call mom today");
});

test("/deadline with a typed ISO date and time, then arrows: Enter stores the moved day with the time (R38)", async ({
  page,
}) => {
  await openEditing(page, "Dates Slash Deadline", "- TODO file taxes");
  await slash(page, "deadl", "Deadline");

  await page.keyboard.type("2026-12-24 18:30");
  await expect(activeDay(page)).toHaveAttribute("data-day", "20261224");
  await page.keyboard.press("ArrowRight"); // Dec 25
  await page.keyboard.press("ArrowDown"); // Jan 1
  await page.keyboard.press("ArrowLeft"); // Dec 31
  await expect(activeDay(page)).toHaveAttribute("data-day", "20261231");
  await page.keyboard.press("Enter");

  await expect(picker(page)).toHaveCount(0);
  await expect
    .poll(async () => (await propsOf(page, "Dates Slash Deadline"))[0]?.deadline)
    .toBe("2026-12-31 18:30");
  expect(await editorText(page)).toBe("file taxes ");
});

test("Escape cancels: nothing stored, nothing typed into the block, still editing with the caret in place", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Dates Escape", "- keep me");
  await slash(page, "sched", "Scheduled");
  await page.keyboard.type("fri");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");

  await expect(picker(page)).toHaveCount(0);
  await expectEditorFocusedNow(page, "after Escape closed the picker");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  expect(await editorText(page)).toBe("keep me ");
  expect(await caret(page)).toEqual({ anchor: 8, head: 8 });
  await page.keyboard.type("x");
  expect(await editorText(page)).toBe("keep me x");
  // Give a stray write time to land before asserting there was none.
  await page.waitForTimeout(600);
  expect((await propsOf(page, "Dates Escape"))[0]?.scheduled).toBeUndefined();
  await expect(outliner.locator(".vr-date")).toHaveCount(0);
});

test("chips: overdue on an open task, muted on a closed one, plain on a note or a future date (B-102)", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Dates Chips",
    [
      "- TODO overdue task",
      `  scheduled:: ${isoOffset(-3)}`,
      "- DONE finished task",
      `  deadline:: ${isoOffset(-3)}`,
      "- TODO later task",
      `  scheduled:: ${isoOffset(0)}`,
      `  deadline:: ${isoOffset(10)} 09:00`,
      "- a plain note",
    ].join("\n"),
  );
  const rows = outliner.locator(".vr-row");
  await expect(rows).toHaveCount(4);

  await expect(chip(rows.nth(0), "scheduled")).toHaveClass(/vr-date-overdue/);
  await expect(chip(rows.nth(0), "scheduled")).toHaveAttribute("title", /overdue by 3d/);

  await expect(chip(rows.nth(1), "deadline")).toHaveClass(/vr-date-closed/);
  await expect(chip(rows.nth(1), "deadline")).not.toHaveClass(/vr-date-overdue/);

  await expect(chip(rows.nth(2), "scheduled")).toHaveText("Today");
  await expect(chip(rows.nth(2), "scheduled")).toHaveClass(/vr-date-today/);
  await expect(chip(rows.nth(2), "deadline")).toHaveClass(/vr-date-upcoming/);
  await expect(chip(rows.nth(2), "deadline")).toContainText("09:00");

  await expect(rows.nth(3).locator(".vr-date")).toHaveCount(0);
  // The dates are metadata beside the text, not part of it.
  await expect(rows.nth(0).locator(".vr-block-view")).toHaveText("overdue task");
});

test("clicking a chip opens the picker on that date without entering edit mode; a new date rewrites it; Remove clears it", async ({
  page,
}) => {
  const outliner = await openPage(
    page,
    "Dates Chip Click",
    `- TODO move me\n  scheduled:: ${isoOffset(5)}`,
  );
  const row = outliner.locator(".vr-row").first();
  await chip(row, "scheduled").click();
  await expect(picker(page)).toBeVisible();
  await expect(activeDay(page)).toHaveAttribute("data-day", dataDay(isoOffset(5)));
  expect(await editingRowIndex(page, outliner)).toBe(-1);

  await page.keyboard.type("+7d");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(chip(row, "scheduled")).toHaveAttribute("data-value", isoOffset(7));
  await expect
    .poll(async () => (await propsOf(page, "Dates Chip Click"))[0]?.scheduled)
    .toBe(isoOffset(7));

  await chip(row, "scheduled").click();
  await picker(page).getByRole("button", { name: "Remove" }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(row.locator(".vr-date")).toHaveCount(0);
  await expect
    .poll(async () => (await propsOf(page, "Dates Chip Click"))[0]?.scheduled)
    .toBeUndefined();
});

test("from block selection, the palette's Set deadline date opens the picker and Backspace edits the date, not the selection", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Dates Palette Selection", "- first\n- second");
  await page.keyboard.press("Escape");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);

  // Park the pointer: `openEditing` clicked the first row, which sits right where the palette's
  // second row opens, and a row appearing under the pointer takes the highlight on hover — so
  // Enter picked "Create page …" (seen once, in a run alongside ten other specs).
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette").first();
  await expect(palette).toBeVisible();
  // Plain text, not `>`: `fill` types no keys, and the palette's command-mode prefix is read
  // from keystrokes — filled, ">Set…" only offers to create a page by that name.
  await palette.locator(".cmd-input").fill("Set deadline date");
  await expect(palette.locator(".cmd-row--active")).toHaveText(/^Set deadline date/);
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();

  // Backspace in selection mode deletes the selected blocks — unless the picker has it first.
  await page.keyboard.type("tomorrowzz");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(picker(page).locator(".dp-text")).toHaveText("tomorrow");
  await page.keyboard.press("Enter");

  await expect(picker(page)).toHaveCount(0);
  await expect
    .poll(async () => (await propsOf(page, "Dates Palette Selection"))[0]?.deadline)
    .toBe(isoOffset(1));
  expect((await readBlocks(page, "Dates Palette Selection")).map((b) => b.content)).toEqual([
    "first",
    "second",
  ]);
  await expect(editor(page)).toHaveCount(0);
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
});

test("while the picker is open, the structural keys never reach the tree, and a date past the calendar is refused without an error (B-145)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const outliner = await openEditing(page, "Dates Keys Held", "- first\n- second");
  // Edit the SECOND block, where Tab would indent it and Alt+Up would move it above "first".
  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await slash(page, "deadl", "Deadline");

  for (const key of ["Tab", "Shift+Tab", "Alt+ArrowUp", "Alt+ArrowDown", "Delete"]) {
    await page.keyboard.press(key);
  }
  // `+10000y` once stored `deadline:: 1202-60-91`, and `+99999999d` threw from the preview on
  // every keystroke (B-145).
  await page.keyboard.type("+99999999d");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator(".dp-preview--error")).toContainText('"+99999999d" is too far');
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.type("+10000y");
  await page.keyboard.press("Enter");
  await expect(picker(page).locator(".dp-preview--error")).toContainText('"+10000y" is too far');
  await page.keyboard.press("Escape");

  await expect(picker(page)).toHaveCount(0);
  await expectEditorFocusedNow(page, "after Escape");
  expect(await editingRowIndex(page, outliner)).toBe(1);
  expect(await rowDepths(page, outliner)).toEqual([0, 0]);
  expect(await editorText(page)).toBe("second ");
  await page.waitForTimeout(600);
  // Order and content only (the trigger's leftover space may not be flushed yet): Alt+Up would
  // have swapped them, Delete at the line end would have joined them.
  expect((await readBlocks(page, "Dates Keys Held")).map((b) => b.content.trim())).toEqual([
    "first",
    "second",
  ]);
  expect((await propsOf(page, "Dates Keys Held")).map((p) => p.deadline)).toEqual([
    undefined,
    undefined,
  ]);
  expect(pageErrors).toEqual([]);
});

test("with several blocks selected the date commands are not offered, since they date one block (B-345)", async ({
  page,
}) => {
  const name = "Dates Multi Selection";
  const outliner = await openEditing(
    page,
    name,
    "- TODO multi one\n- TODO multi two\n- TODO multi three",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);

  const palette = page.locator(".cmd-palette").first();
  /** How many palette rows `title` gets for the typed query. One palette per query, closed with
   * Escape: clearing the input with `fill("")` presses Delete, and Delete in the palette input
   * deletes the selected blocks (B-347). */
  const offered = async (query: string, title: string): Promise<number> => {
    await page.mouse.move(4, 700);
    await page.keyboard.press(`${MOD}+k`);
    await expect(palette).toBeVisible();
    // Typed, so the `>` command-mode prefix is read.
    await page.keyboard.type(`>${query}`);
    // The leading `>` switches the palette to command mode and is not kept in the input.
    await expect(palette.locator(".cmd-input")).toHaveValue(query);
    await expect(palette.locator(".cmd-row, .cmd-empty").first()).toBeVisible();
    const n = await palette.locator(".cmd-row", { hasText: title }).count();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    return n;
  };
  // A block command IS listed for the selection, so the zeros below are not an empty palette.
  expect(await offered("Mark DONE", "Mark DONE")).toBe(1);
  expect(await offered("Set scheduled", "Set scheduled date")).toBe(0);
  expect(await offered("Set deadline", "Set deadline date")).toBe(0);
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);

  // One block selected: offered again.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(1);
  expect(await offered("Set scheduled", "Set scheduled date")).toBe(1);
  expect((await propsOf(page, name)).map((p) => p.scheduled)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});
