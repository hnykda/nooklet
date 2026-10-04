/**
 * The surfaces that make the app navigable rather than just editable: the sidebar with
 * favourites, the all-pages list, history buttons, and Cmd+Enter task cycling.
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

test("the all-pages list shows pages and filters", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Zebra Notes", if_exists: "return" });
  await api(page, "page.create", { name: "Aardvark Notes", if_exists: "return" });

  await page.goto("/pages");
  const list = page.locator(".all-pages-list");
  await expect(list).toContainText("Zebra Notes");
  await expect(list).toContainText("Aardvark Notes");

  await page.locator(".all-pages-filter").fill("Zebra");
  await expect(list).toContainText("Zebra Notes");
  await expect(list).not.toContainText("Aardvark Notes");
});

test("starring a page puts it in the sidebar, and it survives a reload", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Starred Page", if_exists: "return" });

  await page.goto("/pages");
  await page.locator(".all-pages-filter").fill("Starred Page");
  const row = page.locator(".all-pages-row").first();
  await row.locator(".all-pages-star").click();
  await expect(row.locator(".all-pages-star")).toHaveAttribute("aria-pressed", "true");

  // Open the sidebar; the favourite should be listed.
  await page.locator("[aria-label='Toggle sidebar']").click();
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText("Favourites");
  await expect(sidebar).toContainText("Starred Page");

  // It is a synced page property, not browser state, so a reload keeps it.
  await page.reload();
  await page.locator("[aria-label='Toggle sidebar']").click();
  await expect(page.locator(".app-sidebar")).toContainText("Starred Page");
});

test("back and forward move through history", async ({ page }) => {
  await page.goto("/journals");
  await page.locator(".app-history button[aria-label='Back']").waitFor();
  await page.goto("/pages");
  await expect(page).toHaveURL(/\/pages/);

  await page.locator(".app-history button[aria-label='Back']").click();
  await expect(page).toHaveURL(/\/journals/);
  await page.locator(".app-history button[aria-label='Forward']").click();
  await expect(page).toHaveURL(/\/pages/);
});

test("Cmd/Ctrl+Enter cycles a task's state", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Task Cycle", if_exists: "return" });
  await api(page, "page.append", { page: "Task Cycle", markdown: "- plain line" });

  await page.goto("/page/Task%20Cycle");
  const outliner = page.locator(".vr-outliner").first();
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();

  // Cycling a plain block makes it a task, then advances through the marker states.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(outliner.locator(".vr-marker").first()).toBeVisible();
});

test("page properties start collapsed", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Props Page", if_exists: "return" });
  await api(page, "page.append", { page: "Props Page", markdown: "- body" });

  await page.goto("/page/Props%20Page");
  const toggle = page.locator(".page-properties-toggle");
  await expect(toggle).toBeVisible();
  // The editor for properties is hidden until asked for, so it stops pushing content down.
  await expect(page.locator(".page-property-add")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".page-property-add")).toBeVisible();
});

test("a task references the Task page without polluting its text", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Task Ref", if_exists: "return" });
  await api(page, "page.append", { page: "Task Ref", markdown: "- TODO write the report" });

  // The block's own text stays clean — no literal "#Task" written into it.
  const read = (await api(page, "page.read", { page: "Task Ref" })) as { text: string };
  expect(read.text).toContain("TODO write the report");
  expect(read.text).not.toContain("#Task");

  // …yet it references the `Task` page, so once that page exists every task shows up in its
  // linked references — tasks live in the same machinery as any other tag, with nothing
  // special-casing them. A ref to a page that does not exist yet is normal here, exactly as
  // `[[Some Page]]` is before you create it.
  await api(page, "page.create", { name: "Task", if_exists: "return" });
  const backlinks = (await api(page, "page.backlinks", { target: "Task" })) as {
    linked: Array<{ text: string }>;
  };
  expect(backlinks.linked.some((r) => r.text.includes("write the report"))).toBe(true);
});

// B-651: an icon per state, not a text glyph (the empty `☐` read as a missing character on iOS),
// and a checkbox to assistive tech, "mixed" while in progress.
test("each task state renders its own icon", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Task Glyphs", if_exists: "return" });
  await api(page, "page.append", {
    page: "Task Glyphs",
    markdown: "- TODO to do\n- DOING in progress\n- DONE finished",
  });

  await page.goto("/page/Task%20Glyphs");
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner.locator(".vr-marker-TODO svg[data-marker-icon=TODO]")).toHaveCount(1);
  await expect(outliner.locator(".vr-marker-TODO")).toHaveText("");
  await expect(outliner.getByRole("checkbox", { name: "Task: TODO" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(outliner.locator(".vr-marker-DOING svg[data-marker-icon=DOING]")).toHaveCount(1);
  await expect(outliner.locator(".vr-marker-DOING")).toHaveText("");
  await expect(outliner.getByRole("checkbox", { name: "Task: DOING" })).toHaveAttribute(
    "aria-checked",
    "mixed",
  );
  await expect(outliner.locator(".vr-marker-DONE svg[data-marker-icon=DONE]")).toHaveCount(1);
  await expect(outliner.locator(".vr-marker-DONE")).toHaveText("");
  await expect(outliner.getByRole("checkbox", { name: "Task: DONE" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
