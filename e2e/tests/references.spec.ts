/**
 * The references panel: counts, collapsing, disappearing when empty, refreshing after a local
 * edit, and saying so when the request fails.
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

test("no references means no panel at all", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Refs Lonely", if_exists: "return" });
  await api(page, "page.append", { page: "Refs Lonely", markdown: "- nobody links here" });

  await page.goto("/page/Refs%20Lonely");
  await expect(page.locator(".vr-outliner").first()).toBeVisible();
  await expect(page.locator(".references-panel")).toHaveCount(0);
});

test("shows a count and collapses", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Refs Target", if_exists: "return" });
  await api(page, "page.append", { page: "Refs Target", markdown: "- the target" });
  await api(page, "page.create", { name: "Refs Source", if_exists: "return" });
  await api(page, "page.append", {
    page: "Refs Source",
    markdown: "- see [[Refs Target]] for details",
  });

  await page.goto("/page/Refs%20Target");
  const toggle = page.locator(".linked-references .references-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle.locator(".reference-count")).toHaveText("1");
  await expect(page.locator(".linked-references .reference-group")).toHaveCount(1);

  // Collapses, and comes back.
  await toggle.click();
  await expect(page.locator(".linked-references .reference-group")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".linked-references .reference-group")).toHaveCount(1);
});

test("refreshes after a local edit adds a link", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Refs Live", if_exists: "return" });
  await api(page, "page.append", { page: "Refs Live", markdown: "- target block" });
  await api(page, "page.create", { name: "Refs Writer", if_exists: "return" });
  await api(page, "page.append", { page: "Refs Writer", markdown: "- start" });

  // Open the target: no references yet, so no panel.
  await page.goto("/page/Refs%20Live");
  await expect(page.locator(".vr-outliner").first()).toBeVisible();
  await expect(page.locator(".references-panel")).toHaveCount(0);

  // Add the link from the other page, through the API (a second device would look the same).
  await api(page, "page.append", { page: "Refs Writer", markdown: "- now links [[Refs Live]]" });

  // The regression: the panel only refreshed on navigation, so this stayed empty.
  await expect(page.locator(".linked-references .references-toggle")).toBeVisible({
    timeout: 15_000,
  });
});

test("says so when the request fails, and can retry", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Refs Broken", if_exists: "return" });
  await api(page, "page.append", { page: "Refs Broken", markdown: "- content" });

  await page.route("**/api/v1/page.backlinks", (route) => route.abort("failed"));
  await page.goto("/page/Refs%20Broken");

  const error = page.locator(".references-error");
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText("Couldn't load references");
  await expect(error.locator(".references-retry")).toBeVisible();
});
