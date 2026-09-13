/**
 * Probe (2026-09-13, verification of m11/webkit-focus, B-42): refreshes the author's probe did not
 * try — ones that change the ROW LIST around the block being edited, a real second client, and
 * typing straight through refreshes rather than pausing — in WebKit and Chromium, with the `[[`
 * popup open in today's journal.
 *
 * Per scenario it records: editor-focus samples every 20 ms, every focusout (with stack), every
 * DOM insert/remove/move of a node holding focus (with stack), the caret head before and after,
 * whether the popup is still open, and where a key typed afterwards lands.
 *
 * Prints; does not assert.
 *
 * Result on 52e5d20 + m11/webkit-focus (before the B-502 fix): every scenario kept focus and caret
 * in both engines EXCEPT `move-edited-block` in WebKit — caret 57 → 0, popup left open, the next
 * key typed at the start of the block (B-502). After the fix (3973aa1), WebKit: all 7 scenarios keep
 * focus and caret, `move-edited-block` head 57 → 57 and the key appends.
 *
 * Not part of the suite. To re-run: copy it into a directory next to `e2e/helpers/` (e.g.
 * `e2e/verify-probes/`), start `nooklet serve --port <port>` on a scratch data dir serving a fresh
 * `apps/web/dist`, and run Playwright with a config that has that testDir, no globalSetup, baseURL
 * `http://127.0.0.1:<port>` and the chromium + webkit projects (`devices["Desktop Chrome"]`,
 * `devices["Desktop Safari"]`). PROBE_TRACE_DIR says where reports go. Delete the copy after.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

interface Watch {
  unfocused: number[];
  focusouts: Array<{ at: number; to: string | null; stack: string }>;
  domOps: Array<{ at: number; op: string; stack: string }>;
  detached: number[];
}

async function installDomWatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __watch?: Watch; __t0: number };
    const holds = (n: unknown): boolean => {
      const a = document.activeElement;
      return n instanceof Node && !!a && a !== document.body && (n === a || n.contains(a));
    };
    const rec = (op: string) => {
      if (!w.__watch) return;
      w.__watch.domOps.push({
        at: Math.round(performance.now() - w.__t0),
        op,
        stack: (new Error().stack ?? "").split("\n").slice(2, 9).join(" | "),
      });
    };
    const P = Node.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["insertBefore", "appendChild", "removeChild", "replaceChild"]) {
      const orig = P[name] as (...a: unknown[]) => unknown;
      P[name] = function (this: Node, ...args: unknown[]) {
        if (args.slice(0, 2).some(holds)) rec(name);
        return orig.apply(this, args);
      };
    }
    const E = Element.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["remove", "replaceWith", "before", "after", "append", "prepend"]) {
      const orig = E[name] as (...a: unknown[]) => unknown;
      E[name] = function (this: Element, ...args: unknown[]) {
        if (((name === "remove" || name === "replaceWith") && holds(this)) || args.some(holds))
          rec(name);
        return orig.apply(this, args);
      };
    }
  });
}

async function startWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __watch?: Watch; __t0: number; __stop?: () => void };
    w.__stop?.();
    w.__t0 = performance.now();
    const at = () => Math.round(performance.now() - w.__t0);
    const watch: Watch = { unfocused: [], focusouts: [], domOps: [], detached: [] };
    w.__watch = watch;
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Element | null;
      watch.focusouts.push({
        at: at(),
        to: to ? `${to.tagName}.${to.className}` : null,
        stack: (new Error().stack ?? "").split("\n").slice(1, 8).join(" | "),
      });
    };
    document.addEventListener("focusout", onOut, true);
    const timer = setInterval(() => {
      if (!document.activeElement?.closest(".cm-content")) watch.unfocused.push(at());
      if (!document.querySelector(".cm-editor")?.isConnected) watch.detached.push(at());
    }, 20);
    w.__stop = () => {
      clearInterval(timer);
      document.removeEventListener("focusout", onOut, true);
    };
  });
}

async function stopWatch(page: Page): Promise<Watch> {
  return page.evaluate(() => {
    const w = window as unknown as { __watch: Watch; __stop?: () => void };
    w.__stop?.();
    return w.__watch;
  });
}

async function caret(
  page: Page,
): Promise<{ head: number | null; text: string | null; focused: boolean; popup: boolean }> {
  return page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const sel = window.getSelection();
    let head: number | null = null;
    if (content && sel && sel.rangeCount > 0 && content.contains(sel.focusNode)) {
      const r = document.createRange();
      r.selectNodeContents(content);
      r.setEnd(sel.focusNode as Node, sel.focusOffset);
      head = r.toString().length;
    }
    return {
      head,
      text: content?.textContent ?? null,
      focused: !!document.activeElement?.closest(".cm-content"),
      popup: !!document.querySelector(".cmd-popup"),
    };
  });
}

const today = isoOffset(0);

async function setup(page: Page, label: string, browserName: string) {
  const tag = `${label}-${browserName}-${Date.now()}`;
  await api(page, "page.append", {
    page: today,
    markdown: `- above ${tag}\n- base ${tag}\n- below ${tag}`,
  });
  await installDomWatch(page);
  await page.goto("/journals");
  const base = page.locator(".journal-day-today .vr-block-view", { hasText: `base ${tag}` });
  await expect(base).toBeVisible();
  await page.waitForTimeout(1500);
  await base.click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" testing [[dru", { delay: 40 });
  await expect(page.locator(".cmd-popup")).toBeVisible();
  // Past this client's own flush/push/pull.
  await page.waitForTimeout(2500);
  const blocks = await readBlocks(page, today);
  const id = (prefix: string) =>
    blocks.find((b) => b.content.startsWith(`${prefix} ${tag}`))?.id as string;
  return { tag, above: id("above"), base: id("base"), below: id("below") };
}

function report(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 1));
  const d = data as { watch: Watch; before: unknown; after: unknown; afterKey: unknown };
  console.log(
    `=== ${name}: unfocusedSamples=${d.watch.unfocused.length} focusouts=${d.watch.focusouts.length} domOpsOnFocused=${d.watch.domOps.length} detachedSamples=${d.watch.detached.length} before=${JSON.stringify(d.before)} after=${JSON.stringify(d.after)} afterKey=${JSON.stringify(d.afterKey)}`,
  );
}

const DIR = process.env.PROBE_TRACE_DIR ?? "/tmp";

type Scenario = {
  name: string;
  refresh: (
    page: Page,
    ids: { tag: string; above: string; base: string; below: string },
    browser: Browser,
  ) => Promise<void>;
};

const SCENARIOS: Scenario[] = [
  {
    // A block inserted ABOVE the edited one: `<For>` inserts rows before the edited row.
    name: "insert-above",
    refresh: async (page, ids) => {
      for (let i = 0; i < 3; i++) {
        await api(page, "block.insert", {
          ref: ids.above,
          position: "before",
          markdown: `- remote ${i} ${ids.tag}`,
        });
        await page.waitForTimeout(700);
      }
    },
  },
  {
    // Rows around the edited one reorder: below moves above `above`.
    name: "reorder-siblings",
    refresh: async (page, ids) => {
      await api(page, "block.move", { id: ids.below, ref: ids.above, position: "before" });
      await page.waitForTimeout(1500);
    },
  },
  {
    // The EDITED block is moved by another writer within the page (its row DOM moves).
    name: "move-edited-block",
    refresh: async (page, ids) => {
      await api(page, "block.move", { id: ids.base, ref: ids.above, position: "before" });
      await page.waitForTimeout(1500);
    },
  },
  {
    // The edited block is indented under its sibling by another writer (depth change, same order).
    name: "indent-edited-block",
    refresh: async (page, ids) => {
      await api(page, "block.move", { id: ids.base, ref: ids.above, position: "child_last" });
      await page.waitForTimeout(1500);
    },
  },
  {
    // A sibling above gets a child (hasChildren flips on the row above).
    name: "child-under-above",
    refresh: async (page, ids) => {
      await api(page, "block.insert", {
        ref: ids.above,
        position: "child_last",
        markdown: `- kid ${ids.tag}`,
      });
      await page.waitForTimeout(1500);
    },
  },
  {
    // A real second client (its own context = its own device and replica) edits the block below.
    name: "second-client-edits-below",
    refresh: async (page, ids, browser) => {
      const ctx = await browser.newContext();
      const other = await ctx.newPage();
      await other.goto("/journals");
      const row = other.locator(".journal-day-today .vr-block-view", {
        hasText: `below ${ids.tag}`,
      });
      await expect(row).toBeVisible();
      await startWatch(page); // restart: the other context's page load is not the refresh
      await row.click();
      await other.keyboard.press("End");
      await other.keyboard.type(" from another client", { delay: 30 });
      await other.keyboard.press("Escape");
      await expect
        .poll(async () =>
          (await readBlocks(page, today)).some(
            (b) => b.content.endsWith("from another client") && b.content.includes(ids.tag),
          ),
        )
        .toBe(true);
      await page.waitForTimeout(2000);
      await ctx.close();
    },
  },
];

for (const s of SCENARIOS) {
  test(`structural refresh with [[ open: ${s.name}`, async ({ page, browserName, browser }) => {
    const ids = await setup(page, s.name, browserName);
    const before = await caret(page);
    await startWatch(page);
    await s.refresh(page, ids, browser);
    const watch = await stopWatch(page);
    const after = await caret(page);
    await page.keyboard.type("g");
    await page.waitForTimeout(400);
    const afterKey = await caret(page);
    report(DIR, `${s.name}-${browserName}`, { watch, before, after, afterKey });
  });
}

test("typing straight through remote inserts above, [[ open", async ({ page, browserName }) => {
  const ids = await setup(page, "type-through", browserName);
  await startWatch(page);
  const lostAfter: string[] = [];
  let n = 0;
  const writer = (async () => {
    for (let i = 0; i < 6; i++) {
      await api(page, "block.insert", {
        ref: ids.above,
        position: "before",
        markdown: `- tt ${i} ${ids.tag}`,
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  const chars = "gsandmore";
  for (const ch of chars) {
    await page.keyboard.type(ch);
    n++;
    const f = await page.evaluate(() => !!document.activeElement?.closest(".cm-content"));
    if (!f) lostAfter.push(`${n}:${ch}`);
    await page.waitForTimeout(250);
  }
  await writer;
  await page.waitForTimeout(1500);
  const watch = await stopWatch(page);
  const after = await caret(page);
  report(DIR, `type-through-${browserName}`, {
    watch,
    before: { lostAfter },
    after,
    afterKey: null,
  });
});
