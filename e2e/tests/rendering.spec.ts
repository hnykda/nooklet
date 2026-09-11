/**
 * Isolates "does BlockTree render rows at all" from "does the virtual-journal-day handover create
 * the first block", by seeding content through the API and then opening the page.
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

test("a page seeded through the API renders its blocks as rows", async ({ page }) => {
  await page.goto("/journals");

  await api(page, "page.create", { name: "Render Probe" });
  await api(page, "page.append", {
    page: "Render Probe",
    markdown: "- alpha block\n- beta block\n  - nested gamma",
  });

  await page.goto("/page/Render%20Probe");

  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner).toBeVisible();
  await expect(outliner.locator(".vr-row")).toHaveCount(3);
  await expect(outliner).toContainText("alpha block");
  await expect(outliner).toContainText("nested gamma");
});

test("clicking a seeded row opens an editor and accepts many characters", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Edit Probe" });
  await api(page, "page.append", { page: "Edit Probe", markdown: "- start" });

  await page.goto("/page/Edit%20Probe");
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-row")).toHaveCount(1);

  await outliner.locator(".vr-block-view").first().click();
  const cm = page.locator(".cm-content");
  await expect(cm).toBeFocused();

  await page.keyboard.press("End");
  await page.keyboard.type(" and more text", { delay: 20 });
  await expect(cm).toBeFocused();
  await expect(cm).toHaveText("start and more text");
});
