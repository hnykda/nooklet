/**
 * Marker commands under pressure: a key pressed twice before the first write reached the replica
 * (B-282), and the palette's marker commands with several blocks selected (B-346).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, isoOffset, MOD, openEditing } from "../helpers/index.js";

interface Node {
  content: string;
  marker?: string | null;
  properties?: Record<string, string>;
  children?: Node[];
}

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

async function markers(page: Page, name: string): Promise<Array<string | null>> {
  return (await serverBlocks(page, name)).map((b) => b.marker ?? null);
}

function rowMarkers(outliner: Locator): Locator {
  return outliner.locator(".vr-marker");
}

test("Cmd/Ctrl+Enter pressed twice with no pause cycles the marker twice (B-282)", async ({
  page,
}) => {
  const name = "Task Keys Rapid Cycle";
  const outliner = await openEditing(page, name, "- rapid cycle");

  // Back to back: the second keydown is dispatched before the first write has reached the replica.
  await page.keyboard.press(`${MOD}+Enter`);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(rowMarkers(outliner)).toHaveClass(/vr-marker-DOING/);
  await expect.poll(() => markers(page, name)).toEqual(["DOING"]);

  // DOING → DONE (the repeat-aware completion, R35) → null, again with no pause.
  await page.keyboard.press(`${MOD}+Enter`);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(rowMarkers(outliner)).toHaveCount(0);
  await expect.poll(() => markers(page, name)).toEqual([null]);

  // Four presses, four undo steps.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["DONE"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["DOING"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["TODO"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual([null]);
  expect((await serverBlocks(page, name)).map((b) => b.content)).toEqual(["rapid cycle"]);
});

/** Opens the palette in command mode, runs the row titled `title`, and waits for it to close. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  const palette = page.locator(".cmd-palette").first();
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette).toBeVisible();
  // Typed, so the `>` command-mode prefix is read (it is not kept in the input).
  await page.keyboard.type(`>${title}`);
  await expect(palette.locator(".cmd-input")).toHaveValue(title);
  const row = palette.locator(".cmd-row", { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(palette).toHaveCount(0);
}

test("the marker commands act on every selected block, as one undo step (B-346)", async ({
  page,
}) => {
  const name = "Task Keys Multi Selection";
  const outliner = await openEditing(page, name, "- multi one\n- multi two\n- multi three");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(3);

  await runFromPalette(page, "Mark TODO");
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "TODO", "TODO"]);
  await expect(rowMarkers(outliner)).toHaveCount(3);
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(3);

  await runFromPalette(page, "Mark DOING");
  await expect.poll(() => markers(page, name)).toEqual(["DOING", "DOING", "DOING"]);

  // DONE goes through R35's completion for each block: every one is stamped `done`.
  await runFromPalette(page, "Mark DONE");
  await expect.poll(() => markers(page, name)).toEqual(["DONE", "DONE", "DONE"]);
  await expect
    .poll(async () => (await serverBlocks(page, name)).map((b) => Boolean(b.properties?.done)))
    .toEqual([true, true, true]);

  await runFromPalette(page, "Clear task marker");
  await expect.poll(() => markers(page, name)).toEqual([null, null, null]);
  await expect(rowMarkers(outliner)).toHaveCount(0);

  // One Cmd/Ctrl+Z per command, each taking back all three blocks at once.
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(3);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["DONE", "DONE", "DONE"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["DOING", "DOING", "DOING"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "TODO", "TODO"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual([null, null, null]);
  expect((await serverBlocks(page, name)).map((b) => b.content)).toEqual([
    "multi one",
    "multi two",
    "multi three",
  ]);
});

// The per-block half of B-346's DONE: each block completes from ITS own dates (R35), all in one
// batch. The repeating one is rescheduled and reopened while its neighbour is closed, and the one
// undo step has to restore `scheduled` — a reserved key the tree holds in its own column — as well
// as both markers. Added by the adversarial verification of m10/editor-keys.
test("Mark DONE on a selection with a repeating task reschedules only that one, and one undo restores both (B-346)", async ({
  page,
}) => {
  const name = "Task Keys Multi Repeat";
  const yesterday = isoOffset(-1);
  const outliner = await openEditing(
    page,
    name,
    `- TODO multi repeat\n  scheduled:: ${yesterday}\n  repeat:: 1d\n- TODO multi once`,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(outliner.locator(".vr-row-selected")).toHaveCount(2);

  await runFromPalette(page, "Mark DONE");
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "DONE"]);
  const [repeating, once] = await serverBlocks(page, name);
  expect(repeating?.properties?.scheduled).toBe(isoOffset(0));
  expect(repeating?.properties?.done).toBeTruthy();
  expect(once?.properties?.done).toBeTruthy();

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "TODO"]);
  const restored = await serverBlocks(page, name);
  expect(restored.map((b) => b.properties?.scheduled ?? null)).toEqual([yesterday, null]);
  expect(restored.map((b) => b.properties?.done ?? null)).toEqual([null, null]);
});
