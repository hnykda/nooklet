/**
 * Probe (2026-09-13, m9/focus, B-203): does Alt+Enter ("Follow link under cursor") fail in a
 * Playwright-driven Chromium on macOS, and if so, is it the key, the context, or the harness?
 *
 * For each case: the caret offset and buffer before the key, every keydown the window sees (key,
 * code, altKey, and whether something called preventDefault by the time it bubbled back up), the
 * URL 1.5 s later, and the stored blocks.
 *
 * Not part of the suite (it prints; it does not assert). To re-run, copy it into `e2e/tests/` and:
 *   cd e2e && NOOKLET_E2E_PORT=<your port> pnpm exec playwright test tests/<copy>.spec.ts --project=chromium
 * then delete the copy.
 */
import { type Page, test } from "@playwright/test";
import { caret, editorText, openEditing, readBlocks, seedPage } from "../helpers/index.js";

async function traceKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keys: string[] };
    w.__keys = [];
    window.addEventListener(
      "keydown",
      (e) => w.__keys.push(`capture key=${e.key} code=${e.code} alt=${e.altKey}`),
      true,
    );
    window.addEventListener("keydown", (e) =>
      w.__keys.push(`bubble  key=${e.key} defaultPrevented=${e.defaultPrevented}`),
    );
  });
}

async function report(page: Page, label: string, name: string, before: string): Promise<void> {
  await page.waitForTimeout(1500);
  const keys = await page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
  const blocks = (await readBlocks(page, name)).map((b) => b.content);
  console.log(
    `--- ${label}\n  before: ${before}\n  keys: ${keys.join(" | ")}\n  url after: ${new URL(page.url()).pathname}\n  blocks after: ${JSON.stringify(blocks)}`,
  );
}

test("probe: Alt+Enter on a page link — the B-203 repro and variants", async ({ page }, info) => {
  const suffix = `${info.repeatEachIndex} ${Date.now()}`;
  await seedPage(page, "Probe Alt Taxes", "- the target");

  // A. B-203's exact steps: Home, ArrowRight x9, Alt+Enter.
  const a = `Probe Alt A ${suffix}`;
  await openEditing(page, a, "- alpha [[Probe Alt Taxes]] omega");
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await traceKeys(page);
  const beforeA = `caret=${JSON.stringify(await caret(page))} text=${JSON.stringify(await editorText(page))} popups=${await page.locator(".cmd-popup").count()}`;
  await page.keyboard.press("Alt+Enter");
  await report(page, "A: Home + ArrowRight x9 + Alt+Enter", a, beforeA);

  // B. Caret at the end of a trailing link (like follow-link.spec.ts's block-ref test).
  const b = `Probe Alt B ${suffix}`;
  await openEditing(page, b, "- see [[Probe Alt Taxes]]");
  await traceKeys(page);
  const beforeB = `caret=${JSON.stringify(await caret(page))} text=${JSON.stringify(await editorText(page))} popups=${await page.locator(".cmd-popup").count()}`;
  await page.keyboard.press("Alt+Enter");
  await report(page, "B: End of a trailing link + Alt+Enter", b, beforeB);

  // C. A's caret, the key sent through CDP as a macOS keyboard would (modifiers: Alt = 1).
  const c = `Probe Alt C ${suffix}`;
  await openEditing(page, c, "- alpha [[Probe Alt Taxes]] omega");
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await traceKeys(page);
  const beforeC = `caret=${JSON.stringify(await caret(page))} text=${JSON.stringify(await editorText(page))} popups=${await page.locator(".cmd-popup").count()}`;
  const cdp = await page.context().newCDPSession(page);
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 1 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await report(page, "C: A's caret + CDP rawKeyDown Enter with Alt", c, beforeC);

  // D. The caret moved into the link by a click-free route that lands well inside the name.
  const d = `Probe Alt D ${suffix}`;
  await openEditing(page, d, "- alpha [[Probe Alt Taxes]] omega");
  await page.keyboard.press("Home");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await traceKeys(page);
  const beforeD = `caret=${JSON.stringify(await caret(page))} text=${JSON.stringify(await editorText(page))} popups=${await page.locator(".cmd-popup").count()}`;
  await page.keyboard.press("Alt+Enter");
  await report(page, "D: Home + ArrowRight x12 + Alt+Enter", d, beforeD);

  // E. A's caret, but the `[[` autocomplete that walking into the link opened is dismissed first.
  const e = `Probe Alt E ${suffix}`;
  await openEditing(page, e, "- alpha [[Probe Alt Taxes]] omega");
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await traceKeys(page);
  const beforeE = `caret=${JSON.stringify(await caret(page))} text=${JSON.stringify(await editorText(page))} popups=${await page.locator(".cmd-popup").count()}`;
  await page.keyboard.press("Alt+Enter");
  await report(page, "E: A's caret, popup dismissed with Escape, then Alt+Enter", e, beforeE);
});
