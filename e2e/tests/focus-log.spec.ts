/**
 * The focus log in Diagnostics (`apps/web/src/app/focus-log.ts`): the recorder the owner switches
 * on in the desktop app to catch B-42 where Playwright cannot. Runs in both projects — WebKit is
 * the engine it exists for (`playwright.config.ts`).
 *
 * What matters about it, in order: it records what a focus loss would need to be explained (the
 * editor attaching and detaching with the stack that did it, focus events, the refresh), it never
 * records what was typed, it is still on after a reload with the previous load's entries, and it
 * can be read back out.
 */

import { expect, type Page, test } from "@playwright/test";
import { pagePath, readBlocks, seedPage } from "../helpers/index.js";

async function openDiagnostics(page: Page): Promise<void> {
  await page.locator(".app-sync-indicator").click();
  await expect(page.locator(".diag-panel")).toBeVisible();
}

async function readLog(page: Page): Promise<string> {
  await page.locator(".diag-focus-log").getByRole("button", { name: "Show log" }).click();
  return page.locator(".diag-log").inputValue();
}

test("records the editor's focus, the refresh after a write and the stack that ended editing — never the text", async ({
  page,
}) => {
  const name = "Focus Log Recording";
  await seedPage(page, name, "- start");
  await page.goto(pagePath(name));

  await openDiagnostics(page);
  const toggle = page.getByLabel("Record focus changes");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.locator(".diag-close").click();

  await page.locator(".vr-outliner .vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" zebra", { delay: 20 });
  // The write has reached the server, so the replica has changed (and been re-read) meanwhile.
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["start zebra"]);

  // Opening Diagnostics is a click away from the outline: it ends editing, which the log records.
  await openDiagnostics(page);
  const log = await readLog(page);
  expect(log).toContain("nooklet focus log");
  expect(log).toMatch(/editor attach block \S+; host connected=/);
  expect(log).toMatch(/focusin div\.cm-content\.cm-lineWrapping @\S+ → related /);
  expect(log).toContain("keydown char on div.cm-content");
  expect(log).toMatch(/replica change tables=[a-z_,]*block/);
  expect(log).toMatch(/editor detach block \S+\n\s+at \S/);
  expect(log).toMatch(/LOST editor focus → /);
  // Nothing typed, nothing from the page's name.
  expect(log).not.toContain("zebra");
  expect(log).not.toContain(name);

  await page.locator(".diag-focus-log").getByRole("button", { name: "Copy log" }).click();
  await expect(page.locator(".diag-focus-log [role=status]")).toBeVisible();
});

test("stays on across a reload, with the previous page load's entries, until switched off", async ({
  page,
}) => {
  const name = "Focus Log Reload";
  await seedPage(page, name, "- start");
  await page.goto(pagePath(name));
  await openDiagnostics(page);
  await page.getByLabel("Record focus changes").check();
  await page.locator(".diag-close").click();
  await page.locator(".vr-outliner .vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();

  await page.reload();
  await expect(page.locator(".vr-outliner .vr-row").first()).toBeVisible();
  await openDiagnostics(page);
  await expect(page.getByLabel("Record focus changes")).toBeChecked();
  const log = await readLog(page);
  expect(log).toMatch(/--- previous page load ---\n[\s\S]*editor attach block/);
  expect(log).toContain("--- this page load ---");

  await page.locator(".diag-focus-log").getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".diag-focus-log .diag-row")).toContainText("0");
  await page.getByLabel("Record focus changes").uncheck();
  await page.reload();
  await openDiagnostics(page);
  await expect(page.getByLabel("Record focus changes")).not.toBeChecked();
});
