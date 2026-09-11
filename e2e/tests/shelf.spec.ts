/**
 * The right-hand shelf: Shift+click a bullet (or a `[[page]]` link) to park it beside whatever you
 * are reading, keep several at once, dismiss them one at a time or all together.
 *
 * Worth doing here rather than in a component test for two reasons the unit suites cannot reach:
 * the whole feature is a modifier-click travelling from a rendered block through a module-level
 * signal to a component mounted by the shell, and its persistence is real `sessionStorage` across
 * a real reload.
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

/** Seed a page through the real API and open it, waiting until its outline is actually rendered —
 * the local replica pulls the seeded blocks asynchronously, so navigating alone proves nothing. */
async function seedAndOpen(page: Page, name: string, markdown: string): Promise<void> {
  await page.goto("/journals");
  await api(page, "page.create", { name, if_exists: "return" });
  await api(page, "page.append", { page: name, markdown });
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await expect(page.locator(".vr-outliner .vr-block-view").first()).toBeVisible();
}

function blockView(page: Page, text: string) {
  return page.locator(".vr-block-view").filter({ hasText: text }).first();
}

test("Shift+click puts a block on the shelf, newest first, each dismissible", async ({ page }) => {
  await seedAndOpen(page, "Shelf Stack", "- alpha bullet\n- beta bullet");

  // Nothing on it yet, so it takes no space at all.
  await expect(page.locator(".app-shelf")).toHaveCount(0);

  await blockView(page, "alpha bullet").click({ modifiers: ["Shift"] });
  const shelf = page.locator(".app-shelf");
  await expect(shelf).toBeVisible();
  await expect(shelf).toContainText("alpha bullet");
  // The page it came from, as a breadcrumb.
  await expect(shelf.locator(".shelf-crumb").first()).toContainText("Shelf Stack");

  await blockView(page, "beta bullet").click({ modifiers: ["Shift"] });
  await expect(shelf.locator(".shelf-card")).toHaveCount(2);
  // Newest first: the one just added is on top.
  await expect(shelf.locator(".shelf-card").nth(0)).toContainText("beta bullet");
  await expect(shelf.locator(".shelf-card").nth(1)).toContainText("alpha bullet");

  // Dismissing one leaves the other alone.
  await shelf.locator(".shelf-card").nth(0).locator(".shelf-dismiss").click();
  await expect(shelf.locator(".shelf-card")).toHaveCount(1);
  await expect(shelf).toContainText("alpha bullet");
  await expect(shelf).not.toContainText("beta bullet");
});

test("the shelf survives a reload, and clear-all empties it", async ({ page }) => {
  await seedAndOpen(page, "Shelf Reload", "- durable bullet");

  await blockView(page, "durable bullet").click({ modifiers: ["Shift"] });
  await expect(page.locator(".app-shelf")).toContainText("durable bullet");

  // Per-device UI state in `sessionStorage`, not graph data — so it comes back with the tab, and
  // the card re-reads the block from the replica rather than replaying a stored copy of its text.
  await page.reload();
  await expect(page.locator(".app-shelf")).toContainText("durable bullet");

  await page.locator("[aria-label='Clear shelf']").click();
  await expect(page.locator(".app-shelf")).toHaveCount(0);
  // And staying gone across a reload is the other half of "it persists".
  await page.reload();
  await expect(page.locator(".app-shelf")).toHaveCount(0);
});

test("Shift+click on a page link shelves the page, not the block around it", async ({ page }) => {
  await page.goto("/journals");
  await api(page, "page.create", { name: "Shelf Target", if_exists: "return" });
  await api(page, "page.append", { page: "Shelf Target", markdown: "- target page content" });

  await seedAndOpen(page, "Shelf Linker", "- go and read [[Shelf Target]]");

  await page
    .locator(".vr-page-ref")
    .filter({ hasText: "Shelf Target" })
    .first()
    .click({
      modifiers: ["Shift"],
    });

  const shelf = page.locator(".app-shelf");
  await expect(shelf.locator(".shelf-card")).toHaveCount(1);
  await expect(shelf).toContainText("target page content");
  // The block the link was written in must NOT also land on the shelf.
  await expect(shelf).not.toContainText("go and read");
});

test("the shelf closes to a rail and reopens without losing its cards", async ({ page }) => {
  await seedAndOpen(page, "Shelf Toggle", "- stowed bullet");

  await blockView(page, "stowed bullet").click({ modifiers: ["Shift"] });
  await page.locator("[aria-label='Close shelf']").click();
  await expect(page.locator(".app-shelf")).toHaveCount(0);

  await page.locator("[aria-label='Open shelf']").click();
  await expect(page.locator(".app-shelf")).toContainText("stowed bullet");
});

test("block selection kept Cmd/Ctrl+click when Shift moved to the shelf", async ({ page }) => {
  await seedAndOpen(page, "Shelf Collision", "- selectable bullet");

  await blockView(page, "selectable bullet").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".vr-row-selected")).toHaveCount(1);
  // …and it did not quietly also shelve the block.
  await expect(page.locator(".app-shelf")).toHaveCount(0);
});
