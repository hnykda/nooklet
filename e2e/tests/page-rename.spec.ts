/**
 * Renaming a page from its title (B-261). `page.update` promises that "every [[link]]/#tag to it
 * is rewritten; the old name becomes an alias" — the title input used to mint a bare `page.rename`
 * locally, so every reference to the page was orphaned and its old name led to "Create".
 */

import { expect, type Page, test } from "@playwright/test";
import { api, openPage, pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function backlinkCount(page: Page, target: string): Promise<number> {
  const r = await api<{ linked: unknown[] }>(page, "page.backlinks", { target });
  return r.linked.length;
}

async function resolvedName(page: Page, ref: string): Promise<string | null> {
  try {
    const r = await api<{ page: { name: string } }>(page, "page.read", { page: ref });
    return r.page.name;
  } catch {
    return null;
  }
}

test("renaming from the title rewrites every link and tag, and keeps the old name as an alias (B-261)", async ({
  page,
}) => {
  await seedPage(page, "Rename UI Target", "- body");
  await seedPage(page, "Rename UI Linker", "- see [[Rename UI Target]] and #[[Rename UI Target]]");
  expect(await backlinkCount(page, "Rename UI Target")).toBe(1);

  await openPage(page, "Rename UI Target", "- body");
  const title = page.locator(".page-title-input");
  await title.fill("Rename UI Target New");
  await title.press("Enter");
  await expect(page).toHaveURL(/Rename%20UI%20Target%20New/);

  await expect
    .poll(async () => (await readBlocks(page, "Rename UI Linker")).map((b) => b.content))
    .toEqual(["see [[Rename UI Target New]] and #[[Rename UI Target New]]"]);
  expect(await backlinkCount(page, "Rename UI Target New")).toBe(1);
  expect(await resolvedName(page, "Rename UI Target")).toBe("Rename UI Target New");

  // In the app: the linker's link leads to the page, not to "This page doesn't exist yet".
  await page.goto(pagePath("Rename UI Linker"));
  const link = page.locator(".vr-outliner .vr-page-ref").first();
  await expect(link).toContainText("Rename UI Target New");
  await link.click();
  await expect(page).toHaveURL(/Rename%20UI%20Target%20New/);
  await expect(page.locator(".page-view-missing")).toHaveCount(0);
  await expect(page.locator(".vr-outliner").first()).toContainText("body");
});

test("a title rename onto an existing page's name is refused and the title goes back (B-261)", async ({
  page,
}) => {
  await seedPage(page, "Rename UI Taken", "- already here");
  await openPage(page, "Rename UI Clash", "- mine");
  const title = page.locator(".page-title-input");
  await title.fill("Rename UI Taken");
  await title.press("Enter");

  await expect(title).toHaveValue("Rename UI Clash");
  // Said on the title row, not in `window.alert` — which the desktop webview never shows (B-491).
  const notice = page.locator(".page-actions-notice-error");
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toContainText("Rename failed:");
  await expect(page).toHaveURL(/Rename%20UI%20Clash/);
  expect(await resolvedName(page, "Rename UI Clash")).toBe("Rename UI Clash");
  expect((await readBlocks(page, "Rename UI Taken")).map((b) => b.content)).toEqual([
    "already here",
  ]);
});
