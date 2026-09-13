/**
 * Probe (2026-09-13, verification of m11/webkit-focus): does recording the focus log make typing
 * slower or lose keys? 300-block page, 200 characters typed with no delay, log off vs on, 2 reps.
 *
 * Result (fixed build, machine load average ~70-90, so ±20% is noise): every character landed in
 * every run. Chromium off 630/705 ms, on 681/710 ms; WebKit off 1704/1432 ms, on 1596/1588 ms. The
 * log held ~429 lines for 200 keys (keydown + beforeinput per key), none with the typed text.
 *
 * Not part of the suite. To re-run: copy it into a directory next to `e2e/helpers/` (e.g.
 * `e2e/verify-probes/`), start `nooklet serve --port <port>` on a scratch data dir serving a fresh
 * `apps/web/dist`, and run Playwright with a config that has that testDir, no globalSetup, baseURL
 * `http://127.0.0.1:<port>` and the chromium + webkit projects. Delete the copy after.
 */
import { expect, test } from "@playwright/test";
import { api, pagePath } from "../helpers/index.js";

for (const logOn of [false, true]) {
  for (const rep of [1, 2]) {
    test(`typing 200 chars, focus log ${logOn ? "ON" : "off"}, rep ${rep}`, async ({
      page,
      browserName,
    }) => {
      const name = `Typing Cost ${browserName} ${logOn} ${rep} ${Date.now()}`;
      const md = Array.from(
        { length: 300 },
        (_, i) => `- block ${i} with [[Some Page]] and **bold**`,
      ).join("\n");
      await api(page, "page.create", { name, markdown: md });
      if (logOn)
        await page.addInitScript(() => localStorage.setItem("nooklet.debug.focusLog", "1"));
      await page.goto(pagePath(name));
      const first = page.locator(".vr-outliner .vr-block-view").nth(150);
      await first.click();
      await expect(page.locator(".cm-content")).toBeFocused();
      await page.keyboard.press("End");
      const text = "abcdefghij".repeat(20);
      const t0 = Date.now();
      await page.keyboard.type(text);
      await expect(page.locator(".cm-content")).toContainText(text, { timeout: 30000 });
      const ms = Date.now() - t0;
      const entries = await page.evaluate(
        () =>
          (window as unknown as { nookletFocusLog: { text: () => string } }).nookletFocusLog
            .text()
            .split("\n").length,
      );
      console.log(
        `=== ${browserName} log=${logOn} rep=${rep}: ${ms} ms for 200 chars; log lines ${entries}`,
      );
    });
  }
}
