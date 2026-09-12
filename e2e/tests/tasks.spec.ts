/**
 * Tasks (PLAN.md §8, spec R34–R36): Cmd/Ctrl+Enter cycles `null → TODO → DOING → DONE → null`,
 * the rendered marker toggles done on click, DONE reads as finished, the Tasks view filters by
 * state, and every task is a reference to the `Task` page without `#Task` ever entering its text.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  api,
  clickRow,
  editor,
  MOD,
  openEditing,
  openPage,
  pagePath,
  readBlocks,
  seedPage,
} from "../helpers/index.js";

async function markerOf(page: Page, name: string): Promise<string | null> {
  const r = await api<{ tree: Array<{ marker?: string | null }> }>(page, "page.read", {
    page: name,
    format: "json",
  });
  return r.tree[0]?.marker ?? null;
}

function marker(outliner: Locator): Locator {
  return outliner.locator(".vr-marker");
}

test("Cmd/Ctrl+Enter cycles the marker through null, TODO, DOING, DONE and back (R34)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Tasks Cycle Keys", "- ship it");
  await expect(marker(outliner)).toHaveCount(0);

  await page.keyboard.press(`${MOD}+Enter`);
  await expect(marker(outliner)).toHaveClass(/vr-marker-TODO/);
  await expect(marker(outliner)).toHaveText("☐");
  await expect.poll(() => markerOf(page, "Tasks Cycle Keys")).toBe("TODO");

  await page.keyboard.press(`${MOD}+Enter`);
  await expect(marker(outliner)).toHaveClass(/vr-marker-DOING/);
  await expect(marker(outliner)).toHaveText("◐");

  await page.keyboard.press(`${MOD}+Enter`);
  await expect(marker(outliner)).toHaveClass(/vr-marker-DONE/);
  await expect(marker(outliner)).toHaveText("☑");
  await expect.poll(() => markerOf(page, "Tasks Cycle Keys")).toBe("DONE");

  await page.keyboard.press(`${MOD}+Enter`);
  await expect(marker(outliner)).toHaveCount(0);
  await expect.poll(() => markerOf(page, "Tasks Cycle Keys")).toBeNull();

  // The marker is state, never text: the block's content stayed exactly what was typed.
  await expect(editor(page)).toHaveText("ship it");
  expect((await readBlocks(page, "Tasks Cycle Keys")).map((b) => b.content)).toEqual(["ship it"]);
});

test("cycling never leaves the editor: focus and caret survive every step", async ({ page }) => {
  await openEditing(page, "Tasks Cycle Focus", "- focus");
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(editor(page)).toBeFocused();
  }
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("focus!");
});

test("clicking the rendered marker toggles done, and clicking a DONE marker reopens it (R36)", async ({
  page,
}) => {
  const outliner = await openPage(page, "Tasks Click Marker", "- TODO click me");
  await marker(outliner).click();
  await expect(marker(outliner)).toHaveClass(/vr-marker-DONE/);
  await expect.poll(() => markerOf(page, "Tasks Click Marker")).toBe("DONE");
  // The click did not open the editor (R36: "does not enter edit mode").
  await expect(editor(page)).toHaveCount(0);

  await marker(outliner).click();
  await expect(marker(outliner)).toHaveClass(/vr-marker-TODO/);
  await expect.poll(() => markerOf(page, "Tasks Click Marker")).toBe("TODO");
});

test("a DOING task completed by the marker click is DONE, not TODO", async ({ page }) => {
  const outliner = await openPage(page, "Tasks Doing Click", "- DOING half way");
  await marker(outliner).click();
  await expect(marker(outliner)).toHaveClass(/vr-marker-DONE/);
});

test("DONE renders struck through and CANCELED too; open states do not", async ({ page }) => {
  const outliner = await openPage(
    page,
    "Tasks Strike",
    "- DONE finished\n- CANCELED dropped\n- TODO open\n- plain",
  );
  const decoration = (index: number) =>
    outliner
      .locator(".vr-row")
      .nth(index)
      .locator(".vr-block-view")
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(await decoration(0)).toContain("line-through");
  expect(await decoration(1)).toContain("line-through");
  expect(await decoration(2)).not.toContain("line-through");
  expect(await decoration(3)).not.toContain("line-through");
});

test("the Tasks view lists open tasks grouped by page and filters by state", async ({ page }) => {
  await seedPage(
    page,
    "Tasks View Page",
    "- TODO first thing\n- DOING second thing\n- DONE third thing\n- not a task",
  );
  await page.goto("/tasks");
  const group = page.locator(".task-group", { hasText: "Tasks View Page" });
  await expect(group).toHaveCount(1);
  await expect(group.locator(".task-row")).toHaveCount(2);
  await expect(group).toContainText("first thing");
  await expect(group).toContainText("second thing");
  await expect(group).not.toContainText("third thing");
  await expect(group).not.toContainText("not a task");

  // Unticking TODO hides the TODO task and keeps the DOING one.
  await page.locator(".task-state-checkbox", { hasText: "TODO" }).locator("input").uncheck();
  await expect(group.locator(".task-row")).toHaveCount(1);
  await expect(group).toContainText("second thing");
});

test("the Tasks view checkbox completes a task and removes it from the open list", async ({
  page,
}) => {
  await seedPage(page, "Tasks View Done", "- TODO tick me");
  await page.goto("/tasks");
  const group = page.locator(".task-group", { hasText: "Tasks View Done" });
  await group.locator(".task-checkbox").click();
  await expect.poll(() => markerOf(page, "Tasks View Done")).toBe("DONE");
  await expect(group).toHaveCount(0);
});

test("the Tasks view checkbox writes DONE to the database", async ({ page }) => {
  await seedPage(page, "Tasks View Done Data", "- TODO tick me");
  await page.goto("/tasks");
  await page
    .locator(".task-group", { hasText: "Tasks View Done Data" })
    .locator(".task-checkbox")
    .click();
  await expect.poll(() => markerOf(page, "Tasks View Done Data")).toBe("DONE");
  // After a reload the completed task is gone from the open list.
  await page.reload();
  await expect(page.locator(".tasks-view h1")).toBeVisible();
  await expect(page.locator(".task-group", { hasText: "Tasks View Done Data" })).toHaveCount(0);
});

test("the Tasks view links each task to its block, zoomed", async ({ page }) => {
  await seedPage(page, "Tasks View Jump", "- TODO jump here");
  const [block] = await readBlocks(page, "Tasks View Jump");
  await page.goto("/tasks");
  await page
    .locator(".task-group", { hasText: "Tasks View Jump" })
    .locator(".task-content")
    .click();
  await expect(page).toHaveURL(new RegExp(`/page/Tasks%20View%20Jump\\?block=${block?.id}$`));
  await expect(page.locator(".page-view-back")).toContainText("Tasks View Jump");
  await expect(page.locator(".vr-outliner").first()).toContainText("jump here");
});

test("the Tasks view says so when nothing matches", async ({ page }) => {
  await page.goto("/tasks");
  await page.locator(".task-filters input[placeholder='e.g. launch']").fill("no-such-tag-anywhere");
  await expect(page.locator(".tasks-empty")).toContainText("No open tasks match");
});

test("a task shows up in the Task page's linked references without #Task in its text", async ({
  page,
}) => {
  await seedPage(page, "Tasks Ref Source", "- TODO reference the task page");
  await api(page, "page.create", { name: "Task", if_exists: "return" });
  await page.goto(pagePath("Task"));
  const linked = page.locator(".linked-references");
  await expect(linked).toBeVisible({ timeout: 15_000 });
  const group = linked.locator(".reference-group", { hasText: "Tasks Ref Source" });
  await expect(group).toHaveCount(1);
  await expect(group.locator(".reference-item")).toContainText("reference the task page");
  await expect(group).not.toContainText("#Task");
});

test("Cmd/Ctrl+Enter on a second block does not touch the first block's marker", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Tasks Isolated", "- TODO keep\n- make me");
  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(outliner.locator(".vr-row").nth(1).locator(".vr-marker-TODO")).toHaveCount(1);
  await expect(outliner.locator(".vr-row").nth(0).locator(".vr-marker-TODO")).toHaveCount(1);
});
