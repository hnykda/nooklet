/**
 * B-42, as the owner reported it on 2026-09-13: in today's journal, type up to the middle of a
 * link (`testing [[dru`), stop to think, and the app syncs — "it refreshes and the focus is lost".
 * Reported from the desktop app (WKWebView), not from Chromium, so this spec runs in BOTH projects
 * (`playwright.config.ts` adds it to the webkit project's testMatch).
 *
 * What it guards, not what it fixed: neither engine here loses focus in any of these refreshes
 * (probes `tools/probes/webkit-refresh-focus.spec.ts` and `…-real-graph.mjs`, the second on a copy
 * of the owner's graph). The desktop app's own runtime is out of reach from Playwright; the focus
 * log in Diagnostics (`apps/web/src/app/focus-log.ts`) is how a loss there gets recorded. These
 * tests keep the part that can be reached from regressing.
 *
 * Focus is watched from inside the page every 20 ms and through every `focusout`, not with an
 * auto-retrying `toBeFocused()`, which would wait out exactly the loss under test.
 */

import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

interface Watch {
  /** ms offsets (from the start of the watch) at which the editor did not hold focus. */
  unfocusedAt: number[];
  focusouts: Array<{ to: string | null; at: number }>;
}

async function startWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __watch: Watch; __stopWatch?: () => void };
    w.__stopWatch?.();
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const watch: Watch = { unfocusedAt: [], focusouts: [] };
    w.__watch = watch;
    const onFocusOut = (e: FocusEvent): void => {
      const to = e.relatedTarget as Element | null;
      if ((e.target as Element | null)?.closest?.(".cm-editor")) {
        watch.focusouts.push({ to: to ? `${to.tagName}.${to.className}` : null, at: at() });
      }
    };
    document.addEventListener("focusout", onFocusOut, true);
    const timer = setInterval(() => {
      if (!document.activeElement?.closest(".cm-content")) watch.unfocusedAt.push(at());
    }, 20);
    w.__stopWatch = () => {
      clearInterval(timer);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  });
}

async function stopWatch(page: Page): Promise<Watch> {
  return page.evaluate(() => {
    const w = window as unknown as { __watch: Watch; __stopWatch?: () => void };
    w.__stopWatch?.();
    return w.__watch;
  });
}

const today = isoOffset(0);

/** A fresh pair of blocks in today's journal, the first one being edited with `[[dru` typed and
 * the popup open. Returns the sibling's text, for writing to it from "another device". */
async function typeHalfALink(
  page: Page,
  label: string,
): Promise<{ typed: string; sibling: string }> {
  const tag = `${label} ${Date.now()}`;
  await api(page, "page.append", {
    page: today,
    markdown: `- refresh base ${tag}\n- sibling ${tag}`,
  });
  await page.goto("/journals");
  const base = page.locator(".journal-day-today .vr-block-view", {
    hasText: `refresh base ${tag}`,
  });
  await base.click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" testing [[dru", { delay: 40 });
  await expect(page.locator(".cmd-popup")).toBeVisible();
  return { typed: `refresh base ${tag} testing [[dru`, sibling: `sibling ${tag}` };
}

/** Types one more character and checks it went where the caret was, popup still open. */
async function typingStillLands(page: Page): Promise<void> {
  await page.keyboard.type("g");
  await expect(page.locator(".cm-content")).toHaveText(/testing \[\[drug$/);
  await expect(page.locator(".cmd-popup")).toBeVisible();
}

test("pausing mid-link keeps the editor focused through this client's own sync (B-42)", async ({
  page,
}) => {
  const { typed } = await typeHalfALink(page, "own cycle");
  await startWatch(page);
  // The pause: the 500 ms text flush, the push, the page re-read it causes, and the push queue
  // draining. Waited out on the server's side, then the pull/refetch after it.
  await expect
    .poll(async () => (await readBlocks(page, today)).some((b) => b.content === typed))
    .toBe(true);
  await page.waitForTimeout(1500);
  const watch = await stopWatch(page);
  expect(watch, JSON.stringify(watch)).toEqual({ unfocusedAt: [], focusouts: [] });
  await typingStillLands(page);
});

test("pausing mid-link keeps the editor focused when another device edits the same page (B-42)", async ({
  page,
}) => {
  const { sibling } = await typeHalfALink(page, "same page");
  // Past this client's own cycle first, so the write below is the refresh under test.
  await page.waitForTimeout(2000);
  const siblingId = (await readBlocks(page, today)).find((b) => b.content === sibling)?.id;
  expect(siblingId).toBeTruthy();
  await startWatch(page);
  await api(page, "block.update", { id: siblingId, content: `${sibling} edited elsewhere` });
  // The refresh reached this tree: the other block shows the write.
  await expect(
    page.locator(".journal-day-today .vr-block-view", { hasText: `${sibling} edited elsewhere` }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  const watch = await stopWatch(page);
  expect(watch, JSON.stringify(watch)).toEqual({ unfocusedAt: [], focusouts: [] });
  await typingStillLands(page);
});

test("pausing mid-link keeps the editor focused when another device writes a different page (B-42)", async ({
  page,
}) => {
  await typeHalfALink(page, "other page");
  await page.waitForTimeout(2000);
  await api(page, "page.create", { name: "Refresh Focus Elsewhere", if_exists: "return" });
  await startWatch(page);
  await api(page, "page.append", {
    page: "Refresh Focus Elsewhere",
    markdown: `- written elsewhere ${Date.now()}`,
  });
  await page.waitForTimeout(2000);
  const watch = await stopWatch(page);
  expect(watch, JSON.stringify(watch)).toEqual({ unfocusedAt: [], focusouts: [] });
  await typingStillLands(page);
});
