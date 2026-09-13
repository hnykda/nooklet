/**
 * The client as the desktop app shows it (docs/bugs-inbox/desktop-shell.md).
 *
 * The owner, in a desktop build: "I don't see any settings dialog anywhere, nor the question mark
 * icon… not even graph?" The cause was a stale client (B-532), but the claim underneath is worth
 * holding the client to: at the app's default window a first-time user reaches Settings, Graph,
 * All pages and Help by pointer alone. The window is 1100×800 of web content below a native title
 * strip (`TitleBarStyle::Transparent`, B-531), so that is the viewport here, and the page carries
 * the flag the shell injects (`shell_script` in apps/desktop/src-tauri/src/main.rs).
 *
 * This runs in Chromium, not WKWebView: layout is the same page at the same size, and nothing
 * native covers it (B-531's screenshot); real clicks inside the app's WKWebView are unverified.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";

test.use({ viewport: { width: 1100, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
      value: Object.freeze({ platform: "macos", port: 6100 }),
    });
  });
});

/** A control a pointer can actually hit: inside the viewport, and the topmost element at its centre. */
async function expectClickable(page: Page, control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, "has a box").not.toBeNull();
  if (!box) return;
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (top === el || el.contains(top));
  });
  expect(hit, "nothing covers its centre").toBe(true);
}

test("at the desktop window's size, Settings, Graph, All pages and Help are reachable by pointer", async ({
  page,
}) => {
  await page.goto("/journals");
  await expect(page.locator(".app-topbar")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  const help = page.getByRole("button", { name: "Help" });
  for (const control of [
    toggle,
    page.getByRole("button", { name: "Back" }),
    page.getByRole("button", { name: "Forward" }),
    help,
  ]) {
    await expectClickable(page, control);
  }

  // Toggle sidebar → Graph.
  await toggle.click();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expectClickable(page, sidebar.getByRole("link", { name: "Graph" }));
  await sidebar.getByRole("link", { name: "Graph" }).click();
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.locator(".graph-canvas-wrap")).toBeVisible();

  // → All pages.
  await expectClickable(page, sidebar.getByRole("link", { name: "Pages" }));
  await sidebar.getByRole("link", { name: "Pages" }).click();
  await expect(page).toHaveURL(/\/pages$/);
  await expect(page.locator(".all-pages")).toBeVisible();

  // ? → Settings.
  await expectClickable(page, help);
  await help.click();
  await page.locator(".help-item", { hasText: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("the native menu's Settings… and Keyboard Shortcuts open the client's own panels (B-533)", async ({
  page,
}) => {
  await page.goto("/journals");
  await expect(page.locator(".app-topbar")).toBeVisible();

  // Exactly what `on_menu` in main.rs evaluates in the page.
  const chooseMenuItem = (id: string) =>
    page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent("nooklet:desktop-menu", { detail }));
    }, id);

  await chooseMenuItem("settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);

  await chooseMenuItem("shortcuts");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).toContainText("Open settings");
});
