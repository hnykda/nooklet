/**
 * Probe (2026-09-13, m9/undo): the undo fixes on the owner's real graph, not fixtures — a
 * task-heavy page ("Deciding on a Bike": one "Options" block with 35 children, 28 tasks) and a
 * 127-block Czech/English journal day (2022-12-16) with a scheduled DONE task.
 *
 * Checks, each read back from the server:
 * - B-142: palette "Set priority A" on a DONE task, Cmd/Ctrl+Z; Cmd/Ctrl+Enter, Cmd/Ctrl+Z; a date
 *   picked from a chip on the journal day, Cmd/Ctrl+Z.
 * - B-162: Cmd/Ctrl+Up on "Options" while editing it, Cmd/Ctrl+Z keeps the editor, redo folds again.
 *
 * Needs a server on a COPY of the graph, never the live one:
 *   mkdir -p <scratch>/graph && sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"
 *   export NOOKLET_DATA=<scratch>/data   # in the same shell, before any nooklet command
 *   nohup pnpm nooklet serve --data <scratch>/graph --port 6401 > <scratch>/server.log 2>&1 &
 * Then copy this file into `e2e/tests/` and run it against that server (global setup still starts
 * its own on the port, which this probe does not use):
 *   cd e2e && NOOKLET_E2E_PORT=6400 NOOKLET_E2E_URL=http://127.0.0.1:6401 \
 *     pnpm exec playwright test tests/undo-real-graph.spec.ts --project=chromium
 * Delete the copy afterwards, and `lsof -ti :6401 | xargs kill`. The ids below are the owner's
 * graph as of 2026-09-13.
 */
import { expect, type Page, test } from "@playwright/test";
import { api, clickRow, editingRowIndex, expectEditorFocusedNow, MOD } from "../helpers/index.js";

interface Wire {
  id: string;
  marker?: string | null;
  priority?: string | null;
  collapsed?: boolean;
  properties?: Record<string, string>;
  children?: Wire[];
}

async function block(page: Page, pageName: string, id: string): Promise<Wire | undefined> {
  const out = await api<{ tree?: Wire[] }>(page, "page.read", { page: pageName, format: "json" });
  const find = (nodes: Wire[] | undefined): Wire | undefined => {
    for (const n of nodes ?? []) {
      if (n.id === id) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(out.tree);
}

async function palette(page: Page, title: string): Promise<void> {
  await page.mouse.move(4, 700);
  await page.keyboard.press(`${MOD}+k`);
  const p = page.locator(".cmd-palette");
  await expect(p).toBeVisible();
  await p.locator(".cmd-input").fill(title);
  await expect(p.locator(".cmd-row--active")).toHaveText(new RegExp(`^${title}`));
  await page.keyboard.press("Enter");
  await expect(p).toHaveCount(0);
}

const JOB = "Deciding on a Bike";
const OPTIONS = "1m287mdbcvab1f";
const EA_ORG = "1m287mdbcvab1k"; // "2. Figure out something broken in some org", DONE

test("real graph: priority, Cmd+Enter and collapse undo on a task-heavy page", async ({ page }) => {
  await page.goto(`/page/${encodeURIComponent(JOB)}`);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").nth(2)).toBeVisible();
  const rows = await outliner.locator(".vr-row").count();
  console.log("rows on page:", rows);

  // Row 2 is the EA org task (row 0 Options, row 1 its first child).
  await clickRow(page, outliner, 2);
  await palette(page, "Set priority A");
  await expect.poll(async () => (await block(page, JOB, EA_ORG))?.priority).toBe("A");
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await block(page, JOB, EA_ORG))?.priority ?? null).toBeNull();
  console.log("priority A undone");

  await clickRow(page, outliner, 2);
  await page.keyboard.press(`${MOD}+Enter`); // DONE -> no marker
  await expect.poll(async () => (await block(page, JOB, EA_ORG))?.marker ?? null).toBeNull();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await block(page, JOB, EA_ORG))?.marker).toBe("DONE");
  console.log("Cmd+Enter undone");

  await clickRow(page, outliner, 0);
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await page.keyboard.press(`${MOD}+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(rows);
  await expectEditorFocusedNow(page, "after undoing the collapse of Options");
  expect(await editingRowIndex(page, outliner)).toBe(0);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(outliner.locator(".vr-row")).toHaveCount(1);
  await expect.poll(async () => (await block(page, JOB, OPTIONS))?.collapsed).toBe(true);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await block(page, JOB, OPTIONS))?.collapsed ?? false).toBe(false);
  console.log("collapse undo/redo kept the editor");
});

const DAY = "2022-12-16";
const GLOVES = "1m287mdbejacy5"; // "rukavice", DONE, scheduled 2022-12-16

test("real graph: a date picked from a chip on a Czech journal day is undone", async ({ page }) => {
  await page.goto(`/page/${DAY}`);
  const chip = page.locator('.vr-date[data-field="scheduled"][data-value="2022-12-16"]').first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(".date-picker")).toBeVisible();
  await page.keyboard.type("+1d");
  await page.keyboard.press("Enter");
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect
    .poll(async () => (await block(page, DAY, GLOVES))?.properties?.scheduled)
    .not.toBe("2022-12-16");
  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(async () => (await block(page, DAY, GLOVES))?.properties?.scheduled)
    .toBe("2022-12-16");
  console.log("chip date undone");
});
