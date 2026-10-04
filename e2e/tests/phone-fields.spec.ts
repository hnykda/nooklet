/**
 * B-705 guard: on a touch screen no form field may be under 16px. iOS zooms the page in when one
 * takes focus and never zooms back (B-648, B-705), and every new form used to bring it back — the
 * fix was per field. Now one rule in `apps/web/src/styles/shell.css` covers every field under
 * `(pointer: coarse)`; this walks every view with a form, at an iPhone 13's viewport with touch,
 * and checks each visible field's computed size, so a new component rule cannot undercut it
 * unnoticed. Neither engine here zooms on focus — the Simulator check for that is
 * `tools/probes/phone-input/`.
 */

import { devices, expect, type Page, test } from "@playwright/test";
import { openGraphMenu } from "../helpers/graph-menu.js";
import { MOD, openPage, pagePath } from "../helpers/index.js";

test.use({ ...devices["iPhone 13"] });

/** Every visible text-like field on the page, with its computed font size. */
async function fieldSizes(page: Page): Promise<{ field: string; size: number }[]> {
  return page.evaluate(() => {
    const skip = new Set([
      "checkbox",
      "radio",
      "range",
      "color",
      "file",
      "button",
      "submit",
      "reset",
      "image",
      "hidden",
    ]);
    return [...document.querySelectorAll<HTMLElement>("input, textarea, select")]
      .filter((el) => !(el instanceof HTMLInputElement && skip.has(el.type)))
      .filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      )
      .map((el) => ({
        field:
          `${el.tagName.toLowerCase()}.${el.className || "-"}` +
          `[${el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? ""}]`,
        size: Number.parseFloat(getComputedStyle(el).fontSize),
      }));
  });
}

async function expectFieldsAtLeast16(page: Page, where: string, atLeast = 1): Promise<void> {
  const fields = await fieldSizes(page);
  expect(fields.length, `${where}: fields found`).toBeGreaterThanOrEqual(atLeast);
  const small = fields.filter((f) => f.size < 16);
  expect(small, `${where}: fields under 16px`).toEqual([]);
}

test("B-705: every form field is at least 16px on a touch screen", async ({ page }) => {
  // A page: its title (rename) and the Properties form.
  await openPage(page, "Phone Fields Page", "- one\n- two");
  await page.getByRole("button", { name: /Properties/ }).click();
  await expect(page.locator(".page-property-add-key")).toBeVisible();
  await expectFieldsAtLeast16(page, "page title + properties", 3);
  // The title keeps its own, bigger size (`--field-font-size`), not the 16px floor.
  const title = await page
    .locator(".page-title-input")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(title).toBeGreaterThan(20);

  // Find in page.
  await page.locator(".page-scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${MOD}+f`);
  await expect(page.locator(".page-find-input")).toBeVisible();
  await expectFieldsAtLeast16(page, "find in page");
  await page.keyboard.press("Escape");

  // The page icon's emoji picker search.
  await page.getByRole("button", { name: "Page actions" }).tap();
  await page.getByRole("menuitem", { name: "Add icon" }).tap();
  await expect(page.locator(".emoji-picker-search")).toBeVisible();
  await expectFieldsAtLeast16(page, "emoji picker");
  await page.keyboard.press("Escape");

  // An empty day's draft line.
  await page.goto(pagePath("2001-02-03"));
  await expect(page.locator(".vr-draft-input")).toBeVisible();
  await expectFieldsAtLeast16(page, "empty day draft");

  // Search, filters open.
  await page.goto("/search?q=one");
  await page.locator(".search-filters > summary").click();
  await expect(page.locator(".search-filters input").first()).toBeVisible();
  await expectFieldsAtLeast16(page, "search", 2);

  // Tasks and their filter.
  await page.goto("/tasks");
  await expect(page.locator(".task-filters")).toBeVisible();
  await expectFieldsAtLeast16(page, "tasks");

  // Settings, Devices' add-a-device form included.
  await page.goto("/journals");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator(".set-panel")).toBeVisible();
  const devicesSection = page.locator("#set-devices");
  await devicesSection.getByRole("button", { name: "Add a device" }).click();
  await expect(
    devicesSection.getByLabel("Address your phone uses to reach this server"),
  ).toBeVisible();
  await expectFieldsAtLeast16(page, "settings + devices");
  await page.keyboard.press("Escape");

  // The graph switcher: rename and the add-a-server form.
  await page.goto("/journals");
  await openGraphMenu(page); // B-709: the sidebar title, not a top-bar button
  await page.getByText("Add a graph").click();
  const sync = page.getByRole("button", { name: /Sync with a server/s });
  if (await sync.isVisible()) await sync.click();
  await expect(page.getByLabel("Server address")).toBeVisible();
  await expectFieldsAtLeast16(page, "graph switcher add form", 2);

  // The connect screen a pairing link opens (B-655's browser path), with its device-name field.
  // A fresh load (`/pages`, not the `/journals` already open: a hash change alone does not reload).
  await page.goto(`/pages#pair=nkp_${"a".repeat(22)}`);
  await expect(page.getByLabel("Name this device")).toBeVisible();
  await expectFieldsAtLeast16(page, "pairing connect screen");
});

test("B-705: focusing the graph switcher's server address leaves the page unzoomed and in the screen", async ({
  page,
}) => {
  await page.goto("/journals");
  await openGraphMenu(page); // B-709: the sidebar title, not a top-bar button
  await page.getByText("Add a graph").click();
  const sync = page.getByRole("button", { name: /Sync with a server/s });
  if (await sync.isVisible()) await sync.click();
  const field = page.getByLabel("Server address");
  await field.tap();
  await expect(field).toBeFocused();
  await page.keyboard.type("https://nooklet.example.com/g/work");
  const m = await page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(m.scale).toBe(1);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
});
