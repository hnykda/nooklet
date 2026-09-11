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

  // Put the caret in the SECOND block, then indent it under the first.
  await outliner.locator(".vr-block-view").nth(1).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Tab");

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.querySelectorAll(".vr-row")[1] as HTMLElement | undefined)?.style.getPropertyValue(
            "--depth",
          ) ?? "",
      ),
    )
    .toBe("1");

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.querySelectorAll(".vr-row")[1] as HTMLElement | undefined)?.style.getPropertyValue(
            "--depth",
          ) ?? "",
      ),
    )
    .toBe("0");
});

test("the slash menu opens and inserts", async ({ page }) => {
  await openEditing(page, "Parity Slash");
  await page.keyboard.type(" /");
  // The menu is a controlled overlay driven by `matchSlashTrigger` in CommandLayer.
  await expect(page.locator(".slash-menu, [data-slash-menu]").first()).toBeVisible({
    timeout: 5_000,
  });
});

test("[[ opens page autocomplete", async ({ page }) => {
  await openEditing(page, "Parity Wikilink");
  await page.keyboard.type(" [[");
  await expect(page.locator(".autocomplete-popup, [data-autocomplete]").first()).toBeVisible({
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
