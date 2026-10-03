/**
 * B-608: Mod+Enter, the slash menu and Settings follow the graph's task workflow, Logseq's
 * `:preferred-workflow`. The owner's graph uses `:now` (72 LATER, 5 NOW, 0 TODO) and its LATER
 * tasks used to cycle to no marker at all.
 *
 * Each test sets the workflow in Settings first. The graph's own suggestion (imported
 * `:preferred-workflow`, else inferred from its markers) depends on everything else the e2e run
 * has seeded into the shared server — whichever pair dominates — so it is not asserted here; the
 * inference is covered by `packages/server/src/importer/logseq.test.ts` and `host-guard.test.ts`.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, clickRow, MOD, openEditing } from "../helpers/index.js";

interface Node {
  content: string;
  marker?: string | null;
  children?: Node[];
}

/** Settings → Tasks → Task workflow. Stored per graph on this device, read at the next load. */
async function chooseWorkflow(page: Page, value: "now" | "todo"): Promise<void> {
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.locator("#set-task-workflow").selectOption(value);
  await expect(page.locator("#set-task-workflow")).toHaveValue(value);
  await page.getByRole("button", { name: "Close" }).click();
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

test("a graph set to LATER/NOW: Mod+Enter cycles LATER → NOW → DONE → none → LATER, and a plain block starts at LATER", async ({
  page,
}) => {
  const name = "Workflow Owner Style";
  await chooseWorkflow(page, "now");
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

test("a graph set to LATER/NOW: the slash menu offers LATER first, and /now marks NOW", async ({
  page,
}) => {
  const name = "Workflow Slash";
  await chooseWorkflow(page, "now");
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
  await chooseWorkflow(page, "todo");

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
