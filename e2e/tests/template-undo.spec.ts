/**
 * B-108: a template inserted with `/template` is ONE step of the editor's own undo history, the
 * same as a split or a paste. Both insertion shapes (ADR 019): into an empty bullet, and as the
 * siblings after a bullet with text. Undo takes the whole copy away, redo puts it back, and the
 * graph (read through the API, not the screen) agrees each time.
 *
 * Names are prefixed `Template Undo` and the template is called `undocopy`, so nothing collides
 * with `templates.spec.ts`, which shares the server in a full run.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  api,
  editingRowIndex,
  MOD,
  openEditing,
  rowDepths,
  rowTexts,
  seedPage,
} from "../helpers/index.js";

const LIBRARY = "Template Undo Library";
const LIBRARY_MD = `- Checklist
  template:: undocopy
  - first step
  - TODO second step`;

interface Node {
  id: string;
  content: string;
  marker?: string | null;
  children: Node[];
}

/** The page as the server has it: top-level contents, and each one's child contents. */
async function serverShape(page: Page, name: string): Promise<Array<[string, string[]]>> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  return (out.tree ?? []).map((n) => [n.content, n.children.map((c) => c.content)]);
}

/** Type `/template`, take the slash menu's Template row, filter the picker, pick with Enter. */
async function pickTemplate(page: Page, name: string): Promise<void> {
  await page.keyboard.type("/template");
  const menu = page.locator(".cmd-popup").first();
  await expect(menu).toBeVisible();
  await menu
    .locator('[role="option"]')
    .filter({ hasText: /^Template$/ })
    .click();
  const picker = page.locator(".tpl-picker");
  await expect(picker).toBeVisible();
  await page.keyboard.type(name);
  await expect(picker.locator('[role="option"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await seedPage(page, LIBRARY, LIBRARY_MD);
});

// Every spec shares one server in a full run, and `templates.spec.ts` asserts the exact list of
// templates in Settings. A live `undocopy` left behind turned that test and the two journal tests
// that depend on its choice red, so the library goes once each test is done.
test.afterEach(async ({ page }) => {
  await api(page, "page.delete", { page: LIBRARY });
});

test("Cmd/Ctrl+Z takes back a template inserted into an empty bullet, and redo restores it", async ({
  page,
}) => {
  const name = "Template Undo Empty";
  const outliner = await openEditing(page, name, "- start");
  await page.keyboard.press("Enter");
  await pickTemplate(page, "undocopy");
  await expect
    .poll(() => rowTexts(page, outliner))
    .toEqual(["start", "Checklist", "first step", "second step"]);
  await expect
    .poll(() => serverShape(page, name))
    .toEqual([
      ["start", []],
      ["Checklist", ["first step", "second step"]],
    ]);

  await page.keyboard.press(`${MOD}+z`);
  // The whole copy goes in one step: the bullet is empty again, its children are gone, and the
  // caret is still in it — the split that made the bullet is the NEXT undo, not this one.
  await expect.poll(() => rowTexts(page, outliner)).toEqual(["start", ""]);
  expect(await editingRowIndex(page, outliner)).toBe(1);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect
    .poll(() => serverShape(page, name))
    .toEqual([
      ["start", []],
      ["", []],
    ]);

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect
    .poll(() => rowTexts(page, outliner))
    .toEqual(["start", "Checklist", "first step", "second step"]);
  expect(await rowDepths(page, outliner)).toEqual([0, 0, 1, 1]);
  await expect
    .poll(() => serverShape(page, name))
    .toEqual([
      ["start", []],
      ["Checklist", ["first step", "second step"]],
    ]);
});

test("Cmd/Ctrl+Z takes back a template inserted after a bullet with text, caret back where it was", async ({
  page,
}) => {
  const name = "Template Undo After";
  const outliner = await openEditing(page, name, "- keep me");
  await page.keyboard.type(" ");
  await pickTemplate(page, "undocopy");
  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(4);
  await expect.poll(() => editingRowIndex(page, outliner)).toBe(1);
  await expect
    .poll(async () => (await serverShape(page, name)).map(([content]) => content.trim()))
    .toEqual(["keep me", "Checklist"]);

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => rowTexts(page, outliner)).toHaveLength(1);
  expect((await rowTexts(page, outliner))[0]?.trim()).toBe("keep me");
  await expect.poll(() => editingRowIndex(page, outliner)).toBe(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect
    .poll(async () => (await serverShape(page, name)).map(([content]) => content.trim()))
    .toEqual(["keep me"]);
});
