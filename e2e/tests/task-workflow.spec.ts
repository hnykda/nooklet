/**
 * B-608: Mod+Enter, the slash menu and Settings follow the graph's task workflow, Logseq's
 * `:preferred-workflow`. The owner's graph uses `:now` (72 LATER, 5 NOW, 0 TODO) and its LATER
 * tasks used to cycle to no marker at all.
 *
 * This spec's server starts with an empty graph, so the workflow comes from what each test seeds:
 * a graph of LATER/NOW tasks with no setting is inferred as `now` by `/api/session`.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, clickRow, MOD, openEditing, seedPage } from "../helpers/index.js";

interface Node {
  content: string;
  marker?: string | null;
  children?: Node[];
}

async function markers(page: Page, name: string): Promise<Array<string | null>> {
  const out = await api<{ tree?: Node[] }>(page, "page.read", { page: name, format: "json" });
  const flat: Array<string | null> = [];
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      flat.push(n.marker ?? null);
      walk(n.children);
    }
  };
  walk(out.tree);
  return flat;
}

test("a LATER/NOW graph: Mod+Enter cycles LATER → NOW → DONE → none → LATER, and a plain block starts at LATER", async ({
  page,
}) => {
  const name = "Workflow Owner Style";
  const outliner = await openEditing(
    page,
    name,
    "- LATER owner style\n- LATER second\n- NOW third\n- plain block",
  );
  const first = async () => (await markers(page, name))[0];

  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(first).toBe("NOW");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(first).toBe("DONE");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(first).toBe(null);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(first).toBe("LATER");

  await clickRow(page, outliner, 3);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(() => markers(page, name)).toEqual(["LATER", "LATER", "NOW", "LATER"]);
});

test("a LATER/NOW graph: the slash menu offers LATER first, and /now marks NOW", async ({
  page,
}) => {
  const name = "Workflow Slash";
  await openEditing(page, name, "- LATER seeded\n- NOW seeded too\n- x");
  // Into the plain block, then open the menu at a run start.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" /");
  const popup = page.locator(".cmd-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator('[role="option"]').first()).toHaveText("LATER / task");
  await page.keyboard.type("now");
  await expect(popup.locator(".cmd-row--active")).toHaveText("NOW");
  await page.keyboard.press("Enter");
  await expect.poll(() => markers(page, name)).toEqual(["LATER", "NOW", "NOW"]);
});

test("a graph set to TODO in Settings: a plain block starts at TODO, a LATER block keeps its pair, and the choice survives a reload", async ({
  page,
}) => {
  const name = "Workflow Todo Choice";
  const markdown = "- plain todo\n- LATER kept\n- LATER more";
  // LATER-heavy (this spec's earlier tests too), so without the choice this graph reads as `now`.
  await seedPage(page, name, markdown);
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const select = page.locator("#set-task-workflow");
  await expect(select).toHaveValue("now");
  await select.selectOption("todo");
  await page.getByRole("button", { name: "Close" }).click();

  // `openEditing` navigates with a full page load, so this also proves the choice was stored.
  const outliner = await openEditing(page, name, markdown);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "LATER", "LATER"]);

  await clickRow(page, outliner, 1);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(() => markers(page, name)).toEqual(["TODO", "NOW", "LATER"]);

  // And after an explicit reload, a new plain block still starts at TODO.
  const other = "Workflow Todo Reload";
  await openEditing(page, other, "- another plain one");
  await page.reload();
  const reloaded = page.locator(".vr-outliner").first();
  // Not in edit mode after a reload: wait for the row's view before clicking it.
  await expect(reloaded.locator(".vr-block-view").first()).toBeVisible();
  await clickRow(page, reloaded, 0);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(() => markers(page, other)).toEqual(["TODO"]);
});
