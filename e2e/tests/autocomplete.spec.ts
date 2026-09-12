/**
 * The `[[` / `#` / `((` popups, driven from a real CodeMirror surface.
 *
 * B-42: typing a query into the `[[` popup kept dropping editor focus — every few characters
 * needed another click. The reported query was a namespaced page (`new/page`), so the `/` is part
 * of the repro on purpose: it is also the slash-menu trigger character.
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

async function openEditing(page: Page, name: string, markdown = "- start"): Promise<void> {
  await page.goto("/journals");
  await api(page, "page.create", { name, if_exists: "return" });
  await api(page, "page.append", { page: name, markdown });
  await page.goto(`/page/${encodeURIComponent(name)}`);
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row").first()).toBeVisible();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
}

interface FocusLoss {
  afterKey: string;
  activeElement: string;
  /** Where focus went, if a `focusout` fired at all — a detached editor loses focus silently. */
  focusout: Array<{ to: string | null; stack: string }>;
}

/**
 * Types `text` one character at a time and checks focus SYNCHRONOUSLY after each — not with an
 * auto-retrying `toBeFocused()`, which would happily wait out a transient loss and pass on exactly
 * the behaviour being tested for. Every `focusout` is recorded with the JS stack that caused it,
 * so a failure names the culprit rather than just the symptom.
 */
async function typeWatchingFocus(page: Page, text: string): Promise<FocusLoss[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __focusout: Array<{ to: string | null; stack: string }> };
    w.__focusout = [];
    document.addEventListener(
      "focusout",
      (e) => {
        const to = e.relatedTarget as Element | null;
        w.__focusout.push({
          to: to ? `${to.tagName.toLowerCase()}.${to.className}` : null,
          stack: (new Error().stack ?? "").split("\n").slice(2, 8).join(" | "),
        });
      },
      true,
    );
  });
  const losses: FocusLoss[] = [];
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 30 });
    const state = await page.evaluate(() => {
      const w = window as unknown as { __focusout: Array<{ to: string | null; stack: string }> };
      const out = w.__focusout;
      w.__focusout = [];
      const active = document.activeElement;
      return {
        focused: !!active?.closest(".cm-content"),
        activeElement: active ? `${active.tagName.toLowerCase()}.${active.className}` : "none",
        focusout: out,
      };
    });
    if (!state.focused || state.focusout.length > 0) {
      losses.push({ afterKey: ch, activeElement: state.activeElement, focusout: state.focusout });
    }
  }
  return losses;
}

test("typing a namespaced query into the [[ popup keeps the editor focused", async ({ page }) => {
  await openEditing(page, "Autocomplete Focus");

  await page.keyboard.type(" testing [[", { delay: 30 });
  await expect(page.locator(".cmd-popup").first()).toBeVisible();

  const losses = await typeWatchingFocus(page, "new/page");
  expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);

  await expect(page.locator(".cm-content")).toHaveText("start testing [[new/page");
  await expect(page.locator(".cmd-popup").first()).toBeVisible();
});

test("a plain query into the [[ popup keeps the editor focused", async ({ page }) => {
  // Same shape without the slash, so the two tests together say whether `/` is the trigger.
  await openEditing(page, "Autocomplete Focus Plain");

  await page.keyboard.type(" see [[", { delay: 30 });
  await expect(page.locator(".cmd-popup").first()).toBeVisible();

  const losses = await typeWatchingFocus(page, "somewhere");
  expect(losses, JSON.stringify(losses, null, 2)).toEqual([]);
  await expect(page.locator(".cm-content")).toHaveText("start see [[somewhere");
});
