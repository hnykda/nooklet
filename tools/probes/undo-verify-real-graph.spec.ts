/**
 * Probe (2026-09-13, verifying m9/undo) on a COPY of the owner's graph, as of that day's backup:
 * - B-281 on real journal days: the block `1m287mdbqzg35g` (2026-09-04) typed into and left
 *   selected, a deadline (set on the copy through the API) on `1m287mdbqzg37n` (2026-09-06) changed
 *   from its chip; Cmd/Ctrl+Z restores the deadline and keeps the typing, redo sets it again. Passed.
 * - On 2026-08-17 (80 blocks): Czech typing, Cmd/Ctrl+Up on the first expanded parent, Cmd/Ctrl+Enter;
 *   three undos take back marker, collapse and text in that order, editor focused. Passed.
 * `nooklet verify` on the copy afterwards: OK (20449 ops).
 *
 * Setup as in `./undo-real-graph.spec.ts` (backup with sqlite3 `.backup`, `NOOKLET_DATA` in scratch,
 * serve the copy). This one ran with a Playwright config that has no globalSetup and a baseURL of
 * the copy's server, so it can use the one port the e2e run would.
 */
import { expect, type Page, test } from "@playwright/test";
import { activeElement, api, editor, MOD } from "../helpers/index.js";

interface Wire {
  id: string;
  content: string;
  marker?: string | null;
  properties?: Record<string, string>;
  children?: Wire[];
}
async function block(page: Page, pageName: string, id: string): Promise<Wire | undefined> {
  const out = await api<{ tree?: Wire[] }>(page, "page.read", { page: pageName, format: "json" });
  const find = (nodes: Wire[] | undefined): Wire | undefined => {
    for (const n of nodes ?? []) {
      if (n.id === id) return n;
      const h = find(n.children);
      if (h) return h;
    }
    return undefined;
  };
  return find(out.tree);
}

test("real graph: selection in one journal day, chip date in another, undo/redo (B-281)", async ({
  page,
}) => {
  const typedDay = "2026-09-04";
  const typedId = "1m287mdbqzg35g";
  const chipDay = "2026-09-06";
  const chipId = "1m287mdbqzg37n";
  await page.goto("/journals");
  await api(page, "block.update", {
    id: chipId,
    properties: { deadline: "2026-08-01" },
    dry_run: false,
  });
  const before = await block(page, typedDay, typedId);
  await page.reload();
  const typedRow = page.locator(`.vr-row[data-block-id="${typedId}"]`);
  const chipRow = page.locator(`.vr-row[data-block-id="${chipId}"]`);
  console.log("rows found:", await typedRow.count(), await chipRow.count());
  await typedRow.locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" ověřeno");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await block(page, typedDay, typedId))?.content)
    .toBe(`${before?.content} ověřeno`);
  await chipRow.locator('.vr-date[data-field="deadline"]').click();
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+20d");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  const picked = await expect
    .poll(async () => (await block(page, chipDay, chipId))?.properties?.deadline)
    .not.toBe("2026-08-01");
  console.log("picked:", (await block(page, chipDay, chipId))?.properties?.deadline);
  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(async () => (await block(page, chipDay, chipId))?.properties?.deadline)
    .toBe("2026-08-01");
  expect((await block(page, typedDay, typedId))?.content).toBe(`${before?.content} ověřeno`);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect
    .poll(async () => (await block(page, chipDay, chipId))?.properties?.deadline)
    .not.toBe("2026-08-01");
  console.log(
    "after redo:",
    (await block(page, chipDay, chipId))?.properties?.deadline,
    await activeElement(page),
  );
  void picked;
});

test("real graph: 80-block journal day, type Czech, collapse a parent, set priority, undo all in order", async ({
  page,
}) => {
  const day = "2026-08-17";
  const out = await api<{ tree?: Wire[] }>(page, "page.read", { page: day, format: "json" });
  const parent = (out.tree ?? []).find(
    (n) => (n.children?.length ?? 0) > 0 && !(n as { collapsed?: boolean }).collapsed,
  );
  if (!parent) throw new Error("no parent with children");
  console.log("parent children:", parent.children?.length);
  await page.goto(`/page/${day}`);
  const outliner = page.locator(".vr-outliner").first();
  const row = page.locator(`.vr-row[data-block-id="${parent.id}"]`);
  await expect(row).toBeVisible();
  await page.waitForTimeout(500);
  const rowsBefore = await outliner.locator(".vr-row").count();
  console.log("rowsBefore", rowsBefore);
  await row.locator(".vr-block-view").click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" žš");
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await expect.poll(() => outliner.locator(".vr-row").count()).toBeLessThan(rowsBefore);
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(async () => (await block(page, day, parent.id))?.marker).toBe("TODO");
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await block(page, day, parent.id))?.marker ?? null).toBeNull();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => outliner.locator(".vr-row").count()).toBe(rowsBefore);
  console.log(
    "after 2 undos content:",
    JSON.stringify((await block(page, day, parent.id))?.content.slice(-6)),
    await activeElement(page),
  );
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await block(page, day, parent.id))?.content).toBe(parent.content);
  await expect(editor(page)).toBeFocused();
});
