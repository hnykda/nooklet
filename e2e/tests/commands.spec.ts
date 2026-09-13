/**
 * Commands that were registered, listed, and dead (exposure audit 2026-09-12, §1.9): each is run
 * the way a person runs it — from the palette, the context menu, a key — against the real app, and
 * judged by what changes on screen and in the server's copy of the graph.
 *
 * The unit suites could not see these: `palette-rows.test.ts` proves a registration reaches a
 * host, but the host behind "Collapse all" was the real `BlockTree`, which simply had no case for
 * it (B-97).
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
  rowTexts,
} from "../helpers/index.js";

function palette(page: Page): Locator {
  return page.locator(".cmd-palette");
}

/** Open the palette, switch to commands with `>`, and return the input. */
async function openCommandPalette(page: Page): Promise<Locator> {
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  const input = palette(page).locator(".cmd-input");
  await input.fill(">");
  await expect(input).toHaveAttribute("placeholder", "Type a command…");
  return input;
}

/** The titles of the rows the palette shows right now (without the category subtitle). */
async function paletteTitles(page: Page): Promise<string[]> {
  return palette(page).locator(".cmd-row > span:first-child").allTextContents();
}

/** Run a command by its exact title from the palette, the way a person would. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  const input = await openCommandPalette(page);
  await input.fill(title);
  const row = palette(page)
    .locator(".cmd-row")
    .filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${title}$`) }) });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(palette(page)).toHaveCount(0);
}

interface WireNode {
  content: string;
  collapsed?: boolean;
  children?: WireNode[];
}

/** `collapsed` per block content, as the SERVER has it — proof the command wrote ops that synced,
 * not just a local re-render. */
async function serverCollapsed(page: Page, name: string): Promise<Record<string, boolean>> {
  const out = await api<{ tree?: WireNode[] }>(page, "page.read", { page: name, format: "json" });
  const flags: Record<string, boolean> = {};
  const walk = (nodes: WireNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      flags[n.content] = n.collapsed === true;
      walk(n.children);
    }
  };
  walk(out.tree);
  return flags;
}

// ── B-105: argument-only commands ───────────────────────────────────────────────────────────────

test("the palette lists no command that needs an argument (B-105)", async ({ page }) => {
  await openPage(page, "Commands Args Only", "- something");
  await openCommandPalette(page);
  const titles = await paletteTitles(page);
  // Sanity: the list is the real one, not empty.
  expect(titles).toContain("Switch page");
  expect(titles).not.toContain("Open page");
  expect(titles).not.toContain("Reveal block");
});

// ── B-97: Collapse all / Expand all ─────────────────────────────────────────────────────────────

test("Collapse all and Expand all fold the whole page with nothing focused, and it persists (B-97)", async ({
  page,
}) => {
  const name = "Commands Collapse All";
  const outliner = await openPage(page, name, "- a\n  - a1\n    - a2\n- b\n  - b1\n- c");
  await expect(outliner.locator(".vr-row")).toHaveCount(6);

  await runFromPalette(page, "Collapse all");
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  expect(await rowTexts(page, outliner)).toEqual(["a", "b", "c"]);
  // Only blocks with children carry the flag; leaves are left alone.
  await expect
    .poll(() => serverCollapsed(page, name))
    .toEqual({ a: true, a1: true, a2: false, b: true, b1: false, c: false });
  await page.reload();
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(3);

  await runFromPalette(page, "Expand all");
  const reloaded = page.locator(".vr-outliner").first();
  await expect(reloaded.locator(".vr-row")).toHaveCount(6);
  await expect
    .poll(() => serverCollapsed(page, name))
    .toEqual({ a: false, a1: false, a2: false, b: false, b1: false, c: false });
  await page.reload();
  await expect(page.locator(".vr-outliner").first().locator(".vr-row")).toHaveCount(6);
});

test("zoomed into a block, Collapse all and Expand all act on that subtree only (B-97)", async ({
  page,
}) => {
  const name = "Commands Collapse Zoomed";
  await openPage(page, name, "- a\n  - a1\n    - a2\n  - a3\n- b\n  - b1");
  const a = (await readBlocks(page, name)).find((blk) => blk.content === "a");
  await page.goto(`${pagePath(name)}?block=${a?.id}`);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row")).toHaveCount(4);

  await runFromPalette(page, "Collapse all");
  // The zoom root stays open — its children are the first level of this view.
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  expect(await rowTexts(page, outliner)).toEqual(["a", "a1", "a3"]);
  await expect
    .poll(() => serverCollapsed(page, name))
    .toEqual({ a: false, a1: true, a2: false, a3: false, b: false, b1: false });

  await runFromPalette(page, "Expand all");
  await expect(outliner.locator(".vr-row")).toHaveCount(4);
  await expect.poll(() => serverCollapsed(page, name)).toMatchObject({ a1: false, b: false });
});

test("Collapse all while editing a block it hides ends editing, and the page stays editable (B-97)", async ({
  page,
}) => {
  const outliner = await openEditing(page, "Commands Collapse Editing", "- a\n  - a1\n- b");
  await clickRow(page, outliner, 1);
  await expect(editor(page)).toHaveText("a1");

  await runFromPalette(page, "Collapse all");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  // The row holding the editor folded away, so the editor went with it rather than lingering
  // detached and swallowing keystrokes.
  await expect(page.locator(".cm-content")).toHaveCount(0);

  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(editor(page)).toHaveText("b!");
});

// ── B-98: Open plugin manager ───────────────────────────────────────────────────────────────────

test("Open plugin manager opens Settings at the list of running plugins, not a blank page (B-98)", async ({
  page,
}) => {
  await openPage(page, "Commands Plugin Manager", "- here");
  const url = page.url();
  await runFromPalette(page, "Open plugin manager");

  // It used to navigate to /settings/plugins, which is not a route, and blank the main area.
  expect(page.url()).toBe(url);
  const section = page.locator(".set-panel #set-plugins");
  await expect(section).toBeInViewport();

  // Whatever the server says is running, the section lists — the e2e server loads the repo's own
  // `plugins/` directory (`packages/server/src/cli.ts#pluginDirsFor`).
  const running = await page.evaluate(async () => {
    const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
    const res = await fetch("/api/v1/plugins", { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { plugins: Array<{ name: string }> }).plugins.map((p) => p.name);
  });
  expect(running.length).toBeGreaterThan(0);
  await expect(section.locator(".set-plugin .set-label")).toHaveText(running);
});
