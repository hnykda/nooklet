/**
 * Getting into, reading from, and steering the outliner in a real browser.
 *
 * Two entry points, lifted from `parity.spec.ts` / `editing.spec.ts` and kept as they were there:
 * `openEditing` seeds an ordinary page through the API and puts the caret at the end of its first
 * block; `openJournal` guarantees a materialised outliner on the journal stream (today starts
 * virtual — PLAN.md §8 — and only becomes a real `BlockTree` once it has a block; since B-335 it
 * makes today real through the API rather than through the draft).
 *
 * Everything else here reads the editor's state the way a person sees it: the CM6 buffer text,
 * the caret as a character offset, each row's depth and rendered text. Nothing reaches into
 * component internals, so these keep working across refactors that keep the DOM contract.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import { api, isoOffset, pagePath, readBlocks, seedPage } from "./api.js";

/** Seeds a page with `markdown`, opens it, and puts the caret at the end of the first block.
 * Returns the page's outliner. */
export async function openEditing(
  page: Page,
  name: string,
  markdown = "- start",
): Promise<Locator> {
  await seedPage(page, name, markdown);
  await page.goto(pagePath(name));
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  return outliner;
}

/** Seeds and opens a page WITHOUT entering edit mode. Returns the outliner. */
export async function openPage(page: Page, name: string, markdown = "- start"): Promise<Locator> {
  await seedPage(page, name, markdown);
  await page.goto(pagePath(name));
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  return outliner;
}

/**
 * Opens the journal with TODAY materialised and returns today's outliner. Writes to TODAY's
 * journal (one "seed" block, only if it has none) — only use this from a test that exists to
 * exercise the journal (docs/BUGS.md B-32).
 *
 * Today is made real through the API BEFORE the page loads, not by committing the virtual draft in
 * the browser, which is what this used to do. Every test gets a fresh browser context and so an
 * empty replica, and the stream draws today as a draft until the first snapshot has said whether
 * today already exists (`journal-draft-sync.spec.ts`, B-243). A draft seen here could therefore be
 * one about to be swapped for the real outliner: the helper filled it, the swap removed it, and
 * `blur()` then waited the whole 30 s test timeout for an element that no longer existed (B-335).
 * How long that window stays open is how long the snapshot takes, so it hit under load. Seeding
 * first leaves exactly one thing to wait for.
 *
 * Scoped to `.journal-day-today`: an "Upcoming" day another spec created renders ABOVE today, so
 * an unscoped `.vr-outliner` `.first()` picks whichever day happens to be on top.
 */
export async function openJournal(page: Page): Promise<Locator> {
  const today = isoOffset(0);
  const existing = await readBlocks(page, today).catch(() => []);
  if (existing.length === 0) await api(page, "page.append", { page: today, markdown: "- seed" });
  await page.goto("/journals");
  const outliner = page.locator(".journal-day-today .vr-outliner");
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  return outliner;
}

/** The editable surface for the row currently being edited. */
export function editor(page: Page): Locator {
  return page.locator(".cm-content");
}

/** Click into row `index` (by ROW, not by `.vr-block-view`: the row being edited has no view —
 * it holds the editor, so clicking that row means clicking into the editor itself). */
export async function clickRow(page: Page, outliner: Locator, index: number): Promise<void> {
  const row = outliner.locator(".vr-row").nth(index);
  const view = row.locator(".vr-block-view");
  if ((await view.count()) > 0) await view.click();
  else await row.locator(".cm-content").click();
  await expect(editor(page)).toBeFocused();
}

/** The CM6 buffer as text, lines joined with `\n`. */
export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    if (!content) return "";
    return [...content.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n");
  });
}

/**
 * The caret (anchor/head) as character offsets into the block's content, derived from the DOM
 * selection — the same thing CodeMirror derives it from, read from outside so the test does not
 * depend on the view object.
 */
export async function caret(page: Page): Promise<{ anchor: number; head: number }> {
  return page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const sel = window.getSelection();
    if (!content || !sel || sel.rangeCount === 0) return { anchor: -1, head: -1 };
    const lines = [...content.querySelectorAll(".cm-line")];
    const offsetOf = (node: Node | null, offset: number): number => {
      if (!node) return -1;
      const line = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line");
      if (!line) return -1;
      let total = 0;
      for (const l of lines) {
        if (l === line) break;
        total += (l.textContent ?? "").length + 1;
      }
      const r = document.createRange();
      r.selectNodeContents(line);
      r.setEnd(node, offset);
      return total + r.toString().length;
    };
    return {
      anchor: offsetOf(sel.anchorNode, sel.anchorOffset),
      head: offsetOf(sel.focusNode, sel.focusOffset),
    };
  });
}

/** Every row's `--depth`, top to bottom. */
export async function rowDepths(page: Page, outliner?: Locator): Promise<number[]> {
  const scope = outliner ?? page.locator(".vr-outliner").first();
  return scope
    .locator(".vr-row")
    .evaluateAll((rows) =>
      rows.map((r) => Number((r as HTMLElement).style.getPropertyValue("--depth").trim() || "0")),
    );
}

/** Every row's visible text (the rendered view, or the live editor for the row being edited). */
export async function rowTexts(page: Page, outliner?: Locator): Promise<string[]> {
  const scope = outliner ?? page.locator(".vr-outliner").first();
  return scope.locator(".vr-row").evaluateAll((rows) =>
    rows.map((r) => {
      const cm = r.querySelector(".cm-content");
      if (cm) {
        return [...cm.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n");
      }
      // Not trimmed: a block split after a space legitimately ends in one.
      return r.querySelector(".vr-block-view")?.textContent ?? "";
    }),
  );
}

/** Which row (by index) holds the editor right now, or -1. */
export async function editingRowIndex(page: Page, outliner?: Locator): Promise<number> {
  const scope = outliner ?? page.locator(".vr-outliner").first();
  return scope
    .locator(".vr-row")
    .evaluateAll((rows) => rows.findIndex((r) => r.querySelector(".cm-content") !== null));
}

/** `document.activeElement`, described — for messages when a focus assertion fails. */
export async function activeElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName.toLowerCase()}.${a.className}` : "none";
  });
}

/**
 * Focus is in the editor RIGHT NOW. A single synchronous read, not `toBeFocused()`: the
 * auto-retrying matcher waits out a transient loss and passes on exactly the behaviour these
 * tests exist to catch (see `./focus.ts` for the per-keystroke version).
 */
export async function expectEditorFocusedNow(page: Page, when: string): Promise<void> {
  const active = await activeElement(page);
  expect(active, `editor should be focused ${when}, but activeElement is ${active}`).toContain(
    "cm-content",
  );
}

/**
 * Click on empty chrome so the editor loses focus and commits.
 *
 * Note what this does NOT do: the surface stays mounted in its row after a blur (nothing sets
 * `editingId` back to null on focusout), so the row keeps showing the CM6 buffer rather than the
 * rendered view. A test that needs the RENDERED view of the block it was editing must move the
 * editor to another row (`clickRow` on a sibling) or reload.
 */
export async function clickAway(page: Page): Promise<void> {
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // A click away ENDS editing (B-74), which unmounts the editor — so "not focused" has to allow
  // for "not there at all". `not.toBeFocused()` on a missing element fails instead.
  await expect
    .poll(() => page.evaluate(() => !document.activeElement?.closest(".cm-content")))
    .toBe(true);
}

/** The platform's `Mod` key for `page.keyboard.press`. The app resolves `Mod` from `navigator`,
 * which in headless Chromium is the HOST platform's. */
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Settings → Tasks → Task workflow, pinned for this browser context (stored per graph on the
 * device, read at the next load). Without a choice the workflow is inferred from the markers on
 * the shared e2e server, and an empty or tied graph is `now` (`7641c43`): a spec expecting
 * Mod+Enter or the slash menu to say TODO passed after specs that seed TODOs and failed run alone
 * or after specs that seed LATER/NOW (B-663). A test that depends on the workflow pins it.
 */
export async function pinTaskWorkflow(page: Page, value: "now" | "todo"): Promise<void> {
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.locator("#set-task-workflow").selectOption(value);
  await expect(page.locator("#set-task-workflow")).toHaveValue(value);
  await page.getByRole("button", { name: "Close" }).click();
}
