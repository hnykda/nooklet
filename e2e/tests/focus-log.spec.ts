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
import {
  api,
  caret,
  clickRow,
  editorText,
  MOD,
  openEditing,
  pagePath,
  readBlocks,
  rowTexts,
  seedPage,
} from "../helpers/index.js";

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

  // Switched off before Clear: while recording, any focus change after the clear is an entry, and
  // under load one landed ("Entries 1", WebKit, full run).
  await page.getByLabel("Record focus changes").uncheck();
  await page.locator(".diag-focus-log").getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".diag-focus-log .diag-row")).toContainText("0");
  await page.reload();
  await openDiagnostics(page);
  await expect(page.getByLabel("Record focus changes")).not.toBeChecked();
});

test("recording changes nothing about editing: a refresh mid-link, another device's move, undo", async ({
  page,
  browserName,
}) => {
  // The owner will switch this on in the app they use every day, and it patches `focus()`, `blur()`
  // and the DOM insertion methods on the prototypes while it runs. If recording changed what
  // editing does, it would hide B-42 or cause something like it. Switched on before the app loads,
  // the way a log left on across a restart starts.
  await page.addInitScript(() => localStorage.setItem("nooklet.debug.focusLog", "1"));
  const name = `Focus Log Editing ${browserName}`;
  const outliner = await openEditing(page, name, "- above\n- base");
  expect(
    await page.evaluate(() =>
      (window as unknown as { nookletFocusLog: { text: () => string } }).nookletFocusLog.text(),
    ),
  ).toContain("recording started");

  await clickRow(page, outliner, 1);
  await page.keyboard.press("End");
  await page.keyboard.type(" testing [[dru", { delay: 30 });
  await expect(page.locator(".cmd-popup")).toBeVisible();
  await expect
    .poll(async () => (await readBlocks(page, name)).map((b) => b.content))
    .toEqual(["above", "base testing [[dru"]);
  const [above, base] = (await readBlocks(page, name)).map((b) => b.id);

  // Sampled from inside the page: an auto-retrying toBeFocused() would wait out a loss.
  await page.evaluate(() => {
    const w = window as unknown as { __unfocused: number; __timer: number };
    w.__unfocused = 0;
    w.__timer = window.setInterval(() => {
      if (!document.activeElement?.closest(".cm-content")) w.__unfocused++;
    }, 20);
  });
  await api(page, "block.update", { id: above, content: "above, edited elsewhere" });
  await expect(outliner.locator(".vr-block-view", { hasText: "edited elsewhere" })).toBeVisible();
  await api(page, "block.move", { id: base, ref: above, position: "before" });
  await expect
    .poll(() => rowTexts(page, outliner))
    .toEqual(["base testing [[dru", "above, edited elsewhere"]);
  await page.waitForTimeout(500);
  const unfocused = await page.evaluate(() => {
    const w = window as unknown as { __unfocused: number; __timer: number };
    clearInterval(w.__timer);
    return w.__unfocused;
  });
  // A move blurs for a microtask at most (refocusAfterReorder), below one 20 ms sample.
  expect(unfocused).toBe(0);
  const end = "base testing [[dru".length;
  expect(await caret(page)).toEqual({ anchor: end, head: end });

  await page.keyboard.type("g");
  await expect.poll(() => editorText(page)).toBe("base testing [[drug");
  await expect(page.locator(".cmd-popup")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmd-popup")).toBeHidden();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorText(page)).not.toBe("base testing [[drug");
  await expect(page.locator(".cm-content")).toBeFocused();

  const log = await page.evaluate(() =>
    (window as unknown as { nookletFocusLog: { text: () => string } }).nookletFocusLog.text(),
  );
  expect(log).toMatch(/dom insertBefore div/);
  expect(log).not.toContain("testing");
});
