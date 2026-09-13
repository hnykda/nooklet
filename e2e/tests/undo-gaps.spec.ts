/**
 * Undo gaps (M9): writes that did not reach the editor's undo history, or an undo that left the
 * editor with nothing to type into.
 *
 * - B-142: a date set with the picker, a priority or a marker set from the palette, were written
 *   through the command `Store` straight to `applyOps`, which the tree's `EditHistory` never sees.
 * - B-191: undo of `/template` into a bullet that already had one of the template's properties.
 * - B-194: Cmd/Ctrl+Z after the block with the last edit left the page.
 * - B-162: undo of a collapse (and of Collapse all) ended editing, so redo had no keyboard target.
 * - B-280: a collapse right after typing was undone after the typing, not before it.
 *
 * Every claim about what was stored reads the server (`page.read`), never the DOM. Page names
 * start `Undo Gaps` and the template is `undogapsprop`, so nothing collides with another spec on
 * the shared server.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
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
  rowTexts,
  seedPage,
} from "../helpers/index.js";

interface Node {
  content: string;
  marker?: string | null;
  priority?: string | null;
  collapsed?: boolean;
  properties?: Record<string, string>;
  children?: Node[];
}

/** Every block in reading order, as the server has it. */
async function serverBlocks(page: Page, name: string): Promise<Node[]> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Node[] = [];
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

async function firstBlock(page: Page, name: string): Promise<Node | undefined> {
  return (await serverBlocks(page, name))[0];
}

function picker(page: Page): Locator {
  return page.locator(".date-picker");
}

/** Run a command by its exact title from the palette, the way a person would. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  // Park the pointer away from where the palette's rows open (see `dates.spec.ts`).
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.locator(".cmd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".cmd-input").fill(title);
  await expect(palette.locator(".cmd-row--active")).toHaveText(new RegExp(`^${title}`));
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

// ── B-142 ─────────────────────────────────────────────────────────────────────────────────────────

test("Cmd/Ctrl+Z takes back a date set with the picker, keeps editing, and redo sets it again (B-142)", async ({
  page,
}) => {
  // Not a TODO: `query.spec.ts` counts the open tasks scheduled for tomorrow on the shared graph.
  const name = "Undo Gaps Picked Date";
  const outliner = await openEditing(page, name, "- ring the bell");
  await page.keyboard.type(" /sched");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu.locator(".cmd-row--active")).toHaveText("Scheduled");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type("tomorrow");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect
    .poll(async () => (await firstBlock(page, name))?.properties?.scheduled)
    .toBe(isoOffset(1));
  const row = outliner.locator(".vr-row").first();
  await expect(row.locator(".vr-date")).toHaveCount(1);

  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(async () => (await firstBlock(page, name))?.properties?.scheduled)
    .toBeUndefined();
  await expect(row.locator(".vr-date")).toHaveCount(0);
  // Only the date went: the text typed before it is the next undo step, not this one.
  expect(await editorText(page)).toBe("ring the bell ");
  await expectEditorFocusedNow(page, "after undoing the date");

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect
    .poll(async () => (await firstBlock(page, name))?.properties?.scheduled)
    .toBe(isoOffset(1));
  await expect(row.locator(".vr-date")).toHaveCount(1);
});

test("Cmd/Ctrl+Z takes back a date picked from a chip, with nothing being edited (B-142)", async ({
  page,
}) => {
  const name = "Undo Gaps Chip Date";
  const outliner = await openPage(page, name, `- water the plants\n  deadline:: ${isoOffset(9)}`);
  const row = outliner.locator(".vr-row").first();
  await row.locator('.vr-date[data-field="deadline"]').click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type("+12d");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect
    .poll(async () => (await firstBlock(page, name))?.properties?.deadline)
    .toBe(isoOffset(12));
  expect(await editingRowIndex(page, outliner)).toBe(-1);

  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(async () => (await firstBlock(page, name))?.properties?.deadline)
    .toBe(isoOffset(9));
  await expect(row.locator('.vr-date[data-field="deadline"]')).toHaveAttribute(
    "data-value",
    isoOffset(9),
  );
});

test("priority and marker set from the palette are each one Cmd/Ctrl+Z (B-142)", async ({
  page,
}) => {
  const name = "Undo Gaps Palette Task";
  await openEditing(page, name, "- TODO sort the mail");

  // No focus assertion after the palette: it does not hand focus back to the editor (the B-270
  // family). Cmd/Ctrl+Z reaches the tree through the global dispatcher either way.
  await runFromPalette(page, "Set priority A");
  await expect.poll(async () => (await firstBlock(page, name))?.priority).toBe("A");
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await firstBlock(page, name))?.priority ?? null).toBeNull();

  await runFromPalette(page, "Mark WAITING");
  await expect.poll(async () => (await firstBlock(page, name))?.marker).toBe("WAITING");
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await firstBlock(page, name))?.marker).toBe("TODO");

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(async () => (await firstBlock(page, name))?.marker).toBe("WAITING");
});

test("a date picked from a chip in another journal day, with a block still selected in this one, is what Cmd/Ctrl+Z takes back (B-281)", async ({
  page,
}) => {
  // Two trees on one screen: the journal stream renders a BlockTree per day. Escape out of editing
  // leaves the block selected, which keeps its tree the active host; a date picked from a chip in
  // ANOTHER day lands in that other tree's history, and Cmd/Ctrl+Z went to the selected tree —
  // it took back the typing there and left the date. Days -4 and -6: no other spec writes to them.
  const dayA = isoOffset(-4);
  const dayB = isoOffset(-6);
  await api(page, "page.append", { page: dayA, markdown: "- undo gaps selected day" });
  await api(page, "page.append", {
    page: dayB,
    markdown: `- undo gaps chip day\n  deadline:: ${isoOffset(-29)}`,
  });
  await page.goto("/journals");
  const sectionA = page.locator(".journal-day", { hasText: "undo gaps selected day" });
  const sectionB = page.locator(".journal-day", { hasText: "undo gaps chip day" });
  await sectionA.locator(".vr-block-view", { hasText: "undo gaps selected day" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.keyboard.press("Escape");
  await expect(sectionA.locator(".vr-row-selected")).toHaveCount(1);
  const contentA = async () =>
    (await readBlocks(page, dayA)).find((b) => b.content.startsWith("undo gaps selected day"))
      ?.content;
  await expect.poll(contentA).toBe("undo gaps selected day typed");

  const deadlineB = async () =>
    (await serverBlocks(page, dayB)).find((b) => b.content === "undo gaps chip day")?.properties
      ?.deadline;
  await sectionB.locator('.vr-date[data-field="deadline"]').click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type("+31d");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(deadlineB).toBe(isoOffset(31));

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(deadlineB).toBe(isoOffset(-29));
  expect(await contentA()).toBe("undo gaps selected day typed");

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(deadlineB).toBe(isoOffset(31));
  expect(await contentA()).toBe("undo gaps selected day typed");
});

// ── B-191 ─────────────────────────────────────────────────────────────────────────────────────────

const LIBRARY = "Undo Gaps Library";

test.describe("template into a bullet with a property", () => {
  test.beforeEach(async ({ page }) => {
    await seedPage(page, LIBRARY, "- Sorted\n  template:: undogapsprop\n  kind:: b\n  - step");
  });
  // `templates.spec.ts` asserts the exact list of templates on the shared server.
  test.afterEach(async ({ page }) => {
    await api(page, "page.delete", { page: LIBRARY });
  });

  test("undo of /template into a bullet that already had the template's property restores the old value (B-191)", async ({
    page,
  }) => {
    const name = "Undo Gaps Template Prop";
    const outliner = await openEditing(page, name, "- start\n- kind:: a");
    await clickRow(page, outliner, 1);
    await expect.poll(() => editorText(page)).toBe("\nkind:: a");
    await page.keyboard.press(`${MOD}+Home`);
    await page.keyboard.type("/template");
    const menu = page.locator(".cmd-popup").first();
    await menu
      .locator('[role="option"]')
      .filter({ hasText: /^Template$/ })
      .click();
    const tplPicker = page.locator(".tpl-picker");
    await expect(tplPicker).toBeVisible();
    await page.keyboard.type("undogapsprop");
    await expect(tplPicker.locator('[role="option"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(tplPicker).toHaveCount(0);
    await expect
      .poll(async () =>
        (await serverBlocks(page, name)).map((b) => [b.content, b.properties ?? {}]),
      )
      .toEqual([
        ["start", {}],
        ["Sorted", { kind: "b" }],
        ["step", {}],
      ]);

    await page.keyboard.press(`${MOD}+z`);
    await expect
      .poll(async () =>
        (await serverBlocks(page, name)).map((b) => [b.content, b.properties ?? {}]),
      )
      .toEqual([
        ["start", {}],
        ["", { kind: "a" }],
      ]);
    await expect.poll(() => editorText(page)).toBe("\nkind:: a");
  });
});

// ── B-194 ─────────────────────────────────────────────────────────────────────────────────────────

test("Cmd/Ctrl+Z after the edited block left the page neither reaches it nor loses the editor (B-194)", async ({
  page,
}) => {
  const name = "Undo Gaps Left Src";
  const dst = "Undo Gaps Left Dst";
  await seedPage(page, dst, "- already here");
  const outliner = await openEditing(page, name, "- keep\n- goes\n  - child");
  await clickRow(page, outliner, 1);
  const goes = (await readBlocks(page, name)).find((b) => b.content === "goes");
  if (!goes) throw new Error("no block goes");
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");

  await api(page, "block.move_to_page", { id: goes.id, page: dst });
  await expect.poll(() => rowTexts(page, outliner), { timeout: 15_000 }).toEqual(["keep"]);
  await expect
    .poll(async () => (await readBlocks(page, dst)).map((b) => b.content), { timeout: 15_000 })
    .toEqual(["already here", "goes typed", "child"]);

  await clickRow(page, outliner, 0);
  await page.keyboard.press("End");
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.type("Z");

  // The editor stayed in "keep" and took the keystroke…
  await expect(editor(page)).toHaveText("keepZ");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["keepZ"]);
  // …and the block on the other page, where nobody is looking, kept what was typed into it.
  expect((await readBlocks(page, dst)).map((b) => b.content)).toEqual([
    "already here",
    "goes typed",
    "child",
  ]);
});

// ── B-162 ─────────────────────────────────────────────────────────────────────────────────────────

test("undoing a collapse keeps editing, so redo collapses it again from the keyboard (B-162)", async ({
  page,
}) => {
  const name = "Undo Gaps Collapse";
  const outliner = await openEditing(page, name, "- parent\n  - kid\n  - kid two");
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect.poll(async () => (await firstBlock(page, name))?.collapsed).toBe(true);

  await page.keyboard.press(`${MOD}+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await expect.poll(async () => (await firstBlock(page, name))?.collapsed ?? false).toBe(false);
  await expectEditorFocusedNow(page, "after undoing the collapse");
  expect(await editingRowIndex(page, outliner)).toBe(0);

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect.poll(async () => (await firstBlock(page, name))?.collapsed).toBe(true);
  await expectEditorFocusedNow(page, "after redoing the collapse");
});

test("undoing Collapse all keeps editing a block that stayed on screen, and redo folds again (B-162)", async ({
  page,
}) => {
  const name = "Undo Gaps Collapse All";
  const outliner = await openEditing(page, name, "- top\n  - inner\n- other\n  - deep");
  await runFromPalette(page, "Collapse all");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  expect(await editingRowIndex(page, outliner)).toBe(0);
  // Back into the row that stayed: the palette does not hand focus back (the B-270 family).
  await clickRow(page, outliner, 0);

  await page.keyboard.press(`${MOD}+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(4);
  await expectEditorFocusedNow(page, "after undoing Collapse all");

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect
    .poll(async () => (await serverBlocks(page, name)).map((b) => b.collapsed === true))
    .toEqual([true, false, true, false]);
});

// ── B-280 ─────────────────────────────────────────────────────────────────────────────────────────

test("typing then collapsing inside the write debounce: Cmd/Ctrl+Z undoes the collapse first (B-280)", async ({
  page,
}) => {
  const name = "Undo Gaps Type Then Collapse";
  const outliner = await openEditing(page, name, "- parent\n  - kid");
  await page.keyboard.type(" more");
  await page.keyboard.press(`${MOD}+ArrowUp`); // well inside the 500 ms debounce
  await expect(outliner.locator(".vr-row")).toHaveCount(1);

  await page.keyboard.press(`${MOD}+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await expect(editor(page)).toHaveText("parent more");

  await page.keyboard.press(`${MOD}+z`);
  await expect(editor(page)).toHaveText("parent");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
});

test("typing then Cmd/Ctrl+Enter inside the write debounce: Cmd/Ctrl+Z takes back the marker first (B-142, B-280)", async ({
  page,
}) => {
  // The block ends up with no marker: `query.spec.ts` counts open tasks on the shared graph.
  const name = "Undo Gaps Type Then Cycle";
  await openEditing(page, name, "- errand");
  await page.keyboard.type(" run");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(async () => (await firstBlock(page, name))?.marker).toBe("TODO");

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await firstBlock(page, name))?.marker ?? null).toBeNull();
  await expect(editor(page)).toHaveText("errand run");
  await expect.poll(async () => (await firstBlock(page, name))?.content).toBe("errand run");
});
