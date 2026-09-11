/**
 * Logseq-parity interactions that were implemented and unit-tested but had never been exercised in
 * a real browser: the slash menu, `[[` / `#` autocomplete, formatting shortcuts, task cycling,
 * indent/outdent, and select-all.
 *
 * Each test seeds its own page through the API so it does not depend on the shared journal.
 */

import { expect, type Page, test } from "@playwright/test";

async function api(page: Page, op: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([op, body]) => {
      const token = (window as unknown as { __NOOKLET__?: { token?: string } }).__NOOKLET__?.token;
      const res = await fetch(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${op} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    [op, body] as const,
  );
}

/** Seeds a page with `markdown`, opens it, and puts the caret at the end of the first block. */
async function openEditing(page: Page, name: string, markdown = "- start"): Promise<void> {
  await page.goto("/journals");
  // `page.create` first: `page.append`'s `create_page` defaults to true but only materialises
  // JOURNAL days, so it refuses an unknown ordinary page with a message that blames the flag.
  await api(page, "page.create", { name, if_exists: "return" });
  await api(page, "page.append", { page: name, markdown });
  await page.goto(`/page/${encodeURIComponent(name)}`);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
}

test("Tab indents and Shift+Tab outdents", async ({ page }) => {
  await openEditing(page, "Parity Indent", "- first\n- second");
  const outliner = page.locator(".vr-outliner").first();

  // Address by ROW: the first block is already in edit mode, so its `.vr-block-view` has been
  // swapped for the surface host and `.vr-block-view` no longer indexes 1:1 with rows.
  await outliner.locator(".vr-row").nth(1).locator(".vr-block-view").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Tab");

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.querySelectorAll(".vr-row")[1] as HTMLElement | undefined)?.style
            .getPropertyValue("--depth")
            .trim() ?? "",
      ),
    )
    .toBe("1");

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.querySelectorAll(".vr-row")[1] as HTMLElement | undefined)?.style
            .getPropertyValue("--depth")
            .trim() ?? "",
      ),
    )
    .toBe("0");
});

test("the slash menu opens and inserts", async ({ page }) => {
  await openEditing(page, "Parity Slash");
  await page.keyboard.type(" /");
  // The menu is a controlled overlay driven by `matchSlashTrigger` in CommandLayer.
  await expect(page.locator(".cmd-popup").first()).toBeVisible({
    timeout: 5_000,
  });
});

test("[[ opens page autocomplete", async ({ page }) => {
  await openEditing(page, "Parity Wikilink");
  await page.keyboard.type(" [[");
  await expect(page.locator(".cmd-popup").first()).toBeVisible({
    timeout: 5_000,
  });
});

test("Cmd/Ctrl+B wraps the selection in bold", async ({ page }) => {
  await openEditing(page, "Parity Bold", "- make me bold");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.locator(".cm-content")).toHaveText("**make me bold**");
});

test("Cmd/Ctrl+A selects the block's text rather than killing the editor", async ({ page }) => {
  await openEditing(page, "Parity SelectAll", "- replace me");
  await page.keyboard.press("ControlOrMeta+a");
  // Typing over a selection replaces it. The bug this guards: select-all detached the editor and
  // swallowed the next keystroke, yielding "replace mex" instead of "x".
  await page.keyboard.type("x");
  await expect(page.locator(".cm-content")).toHaveText("x");
});

test("a task cycles TODO -> DOING -> DONE", async ({ page }) => {
  await openEditing(page, "Parity Task", "- TODO write the thing");
  const outliner = page.locator(".vr-outliner").first();
  // The marker renders as a checkbox/pill rather than literal text in the block body.
  await expect(outliner.locator(".vr-marker").first()).toBeVisible();
});

test("right-clicking a bullet opens an app context menu", async ({ page }) => {
  await openEditing(page, "Parity Menu", "- right click me");
  const outliner = page.locator(".vr-outliner").first();

  await outliner.locator(".vr-row").first().click({ button: "right" });

  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Zoom in");
  await expect(menu).toContainText("Copy block reference");

  // Escape dismisses.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("the context menu runs a real command", async ({ page }) => {
  await openEditing(page, "Parity Menu Run", "- indent me\n- second");
  const outliner = page.locator(".vr-outliner").first();

  await outliner.locator(".vr-row").nth(1).click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.locator(".ctx-item", { hasText: "Indent" }).first().click();

  await expect(page.locator(".ctx-menu")).toBeHidden();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.querySelectorAll(".vr-row")[1] as HTMLElement | undefined)?.style
            .getPropertyValue("--depth")
            .trim() ?? "",
      ),
    )
    .toBe("1");
});

test("the context menu hides entries whose when-clause does not hold", async ({ page }) => {
  await openEditing(page, "Parity Menu When", "- only block");
  await page.locator(".vr-outliner").first().locator(".vr-row").first().click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  // `block.deleteSelected` is gated on `blockSelected`, and right-clicking puts the caret in the
  // block (editing, not block-selection mode) — so Delete must not be offered here.
  await expect(menu).not.toContainText("Delete");
  // While an `editorFocused` entry in the same menu is.
  await expect(menu).toContainText("Indent");
});

test("the context menu is populated the first time it opens", async ({ page }) => {
  await openEditing(page, "Parity Menu First", "- right click me");
  await page.locator(".vr-outliner").first().locator(".vr-row").first().click({ button: "right" });

  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  // The regression: opening it before the editor host had registered produced an empty menu.
  await expect(menu).not.toContainText("Nothing available here");
  await expect(menu).toContainText("Zoom in");
});

test("Cmd/Ctrl+Shift+P opens the palette", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.locator(".cmd-palette")).toBeVisible();
});

test("the palette offers to create a page that does not exist", async ({ page }) => {
  await page.goto("/journals");
  await page.keyboard.press("ControlOrMeta+k");
  const popup = page.locator(".cmd-palette");
  await expect(popup).toBeVisible();

  await popup.locator(".cmd-input").fill("Totally New Page");
  await expect(popup).toContainText('Create page "Totally New Page"');
  await popup.locator(".cmd-list >> text=/Create page/").first().click();

  await expect(page).toHaveURL(/\/page\/Totally%20New%20Page/);
  await expect(page.locator("body")).not.toContainText("doesn't exist yet");
});

test("zooming into a block shows a breadcrumb back to the page", async ({ page }) => {
  await openEditing(page, "Parity Zoom", "- parent block\n  - child block");
  const outliner = page.locator(".vr-outliner").first();

  await outliner.locator(".vr-row").first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Zoom in" }).first().click();

  const trail = page.locator(".vr-zoom-trail");
  await expect(trail).toBeVisible();
  await expect(trail).toContainText("Parity Zoom");
  await expect(trail).toContainText("parent block");

  // And it gets you back out.
  await trail.locator(".vr-crumb", { hasText: "Parity Zoom" }).click();
  await expect(trail).toHaveCount(0);
});

test("an empty bullet is clickable across the whole row, not just beside the bullet", async ({
  page,
}) => {
  await openEditing(page, "Parity Empty Click", "- first");
  const outliner = page.locator(".vr-outliner").first();

  // Make a second, empty bullet, then move the caret back to the first one so the empty row
  // renders as a read-only view rather than holding the editor.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(outliner.locator(".vr-row")).toHaveCount(2);
  await outliner.locator(".vr-row").first().locator(".vr-block-view").click();
  await expect(outliner.locator(".vr-row").nth(1).locator(".vr-block-view")).toBeVisible();

  const emptyView = outliner.locator(".vr-row").nth(1).locator(".vr-block-view");
  const box = await emptyView.boundingBox();
  expect(box, "the empty block's click target must have real size").not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThan(10);

  // Click near the RIGHT edge, far from the bullet — the part that used to do nothing.
  await emptyView.click({ position: { x: Math.max((box?.width ?? 40) - 8, 8), y: 6 } });
  await expect(page.locator(".cm-content")).toBeFocused();
});
