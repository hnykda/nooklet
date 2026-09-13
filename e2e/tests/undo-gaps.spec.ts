/**
 * Undo gaps (M9): writes that did not reach the editor's undo history, or an undo that left the
 * editor with nothing to type into.
 *
 * - B-142: a date set with the picker, a priority or a marker set from the palette, were written
 *   through the command `Store` straight to `applyOps`, which the tree's `EditHistory` never sees.
 * - B-191: undo of `/template` into a bullet that already had one of the template's properties.
 * (B-194 and B-162 tests are added with their fixes.)
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
  editorText,
  expectEditorFocusedNow,
  isoOffset,
  MOD,
  openEditing,
  openPage,
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
