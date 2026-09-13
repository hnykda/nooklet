/**
 * Probe (2026-09-13, verification of m11/webkit-focus): WHY the caret jumps to 0 in WebKit when a
 * refresh moves the row being edited. Logs, around the DOM move of the focused row: activeElement
 * and the DOM selection immediately before and after the native insertBefore, every selectionchange
 * (with the caret offset it implies), focusin/focusout, and focus() calls with stacks.
 *
 * Result before the fix (B-502): both engines — activeElement BODY right after the move, then
 * `refocusAfterReorder`'s microtask calls focus(). Chromium: focusout on the move, head 46 kept.
 * WebKit: NO focusout, head 0 immediately after focus(), then a selectionchange at 0.
 *
 * Not part of the suite. To re-run: copy it into a directory next to `e2e/helpers/` (e.g.
 * `e2e/verify-probes/`), start `nooklet serve --port <port>` on a scratch data dir serving a fresh
 * `apps/web/dist`, and run Playwright with a config that has that testDir, no globalSetup, baseURL
 * `http://127.0.0.1:<port>` and the chromium + webkit projects (`devices["Desktop Chrome"]`,
 * `devices["Desktop Safari"]`). PROBE_TRACE_DIR says where reports go. Delete the copy after.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

test("mechanism: remote move of the edited block", async ({ page, browserName }) => {
  const today = isoOffset(0);
  const tag = `mech-${browserName}-${Date.now()}`;
  await api(page, "page.append", { page: today, markdown: `- above ${tag}\n- base ${tag}` });
  await page.addInitScript(() => {
    const w = window as unknown as { __log: string[]; __on: boolean };
    w.__log = [];
    w.__on = false;
    const t = () => Math.round(performance.now());
    const headOf = (): string => {
      const c = document.querySelector(".cm-content");
      const s = window.getSelection();
      if (!s || s.rangeCount === 0) return "rangeCount=0";
      if (!c?.contains(s.focusNode)) return `outside(${(s.focusNode as Element)?.nodeName})`;
      const r = document.createRange();
      r.selectNodeContents(c);
      r.setEnd(s.focusNode as Node, s.focusOffset);
      return `head=${r.toString().length}`;
    };
    const act = () => {
      const a = document.activeElement;
      return a ? `${a.tagName}.${String(a.className).split(" ")[0]}` : "null";
    };
    const log = (s: string) => w.__on && w.__log.push(`${t()} ${s}`);
    const stack = () =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(1, 7)
        .map((l) => l.trim().slice(0, 90))
        .join(" | ");
    const holds = (n: unknown) => {
      const a = document.activeElement;
      return n instanceof Node && !!a && a !== document.body && (n === a || n.contains(a));
    };
    const P = Node.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["insertBefore", "appendChild", "removeChild", "replaceChild"]) {
      const orig = P[name] as (...a: unknown[]) => unknown;
      P[name] = function (this: Node, ...args: unknown[]) {
        const hit = args.slice(0, 2).some(holds);
        if (hit) log(`BEFORE ${name}: active=${act()} ${headOf()}`);
        const out = orig.apply(this, args);
        if (hit) {
          log(`AFTER  ${name}: active=${act()} ${headOf()}  stack: ${stack()}`);
          queueMicrotask(() => log(`microtask after ${name}: active=${act()} ${headOf()}`));
          requestAnimationFrame(() => log(`frame after ${name}: active=${act()} ${headOf()}`));
        }
        return out;
      };
    }
    document.addEventListener("selectionchange", () =>
      log(`selectionchange active=${act()} ${headOf()}`),
    );
    document.addEventListener(
      "focusin",
      (e) => log(`focusin ${(e.target as Element).className}`),
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => log(`focusout ${(e.target as Element).className}`),
      true,
    );
    const of = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
      log(`focus() on ${this.className} (active=${act()} ${headOf()}) ${stack()}`);
      return of.call(this, o);
    };
  });
  await page.goto("/journals");
  const base = page.locator(".journal-day-today .vr-block-view", { hasText: `base ${tag}` });
  await expect(base).toBeVisible();
  await page.waitForTimeout(1500);
  await base.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" testing [[dru", { delay: 40 });
  await expect(page.locator(".cmd-popup")).toBeVisible();
  await page.waitForTimeout(2500);
  const blocks = await readBlocks(page, today);
  const id = (p: string) => blocks.find((b) => b.content.startsWith(`${p} ${tag}`))?.id;
  await page.evaluate(() => {
    (window as unknown as { __on: boolean }).__on = true;
  });
  await api(page, "block.move", { id: id("base"), ref: id("above"), position: "before" });
  await page.waitForTimeout(2000);
  await page.keyboard.type("g");
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  const text = await page.locator(".cm-content").textContent();
  const dir = process.env.PROBE_TRACE_DIR ?? "/tmp";
  writeFileSync(
    join(dir, `move-mechanism-${browserName}.txt`),
    `${out.join("\n")}\nTEXT ${text}\n`,
  );
  console.log(`=== ${browserName}\n${out.join("\n")}\nTEXT ${text}`);
});
