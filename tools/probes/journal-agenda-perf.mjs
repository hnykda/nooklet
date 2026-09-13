/**
 * Does the journal stream stay fast with the "Scheduled and deadline" section? (impl-journal,
 * 2026-09-13.) Drives a real Chromium against a real `nooklet serve` on a copy of a graph and
 * measures, median of N runs:
 *
 *   load    reload /journals → Today's title plus at least MIN_DAYS day outlines rendered (ms)
 *   edit    long-task milliseconds while typing one character into a block on an earlier stream
 *           day and pausing 900 ms (past the editor's 500 ms debounce, so the write and every
 *           refetch it triggers land inside the window), EDITS times — the per-edit refetch cost
 *   more    scroll the load-more sentinel into view → the day count grows (ms)
 *
 * The browser profile is persistent, so the replica is bootstrapped once and every measured run is
 * a warm start — the state a real user is in.
 *
 * Usage (from the repo root; the server must already be running):
 *   node tools/probes/journal-agenda-perf.mjs <baseURL> <profileDir> <label> [runs]
 *
 * Use a separate <profileDir> per build: the app's service worker caches its bundle, so a profile
 * shared between two builds on one origin can run the other build's code (service workers are also
 * blocked below, belt and braces). SKIP_EDIT=1 skips the edit step — required on builds without
 * B-174's fix, where typing in an earlier day loses the editor after the first write.
 */

import { createRequire } from "node:module";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const [baseURL, profileDir, label, runsArg] = process.argv.slice(2);
if (!baseURL || !profileDir || !label) {
  console.error("usage: journal-agenda-perf.mjs <baseURL> <profileDir> <label> [runs]");
  process.exit(2);
}
const RUNS = Number(runsArg ?? 5);
const MIN_DAYS = 8;
const EDITS = 8;

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  serviceWorkers: "block",
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

async function streamReady() {
  await page.locator(".journal-day-today .journal-day-title").waitFor({ timeout: 300_000 });
  await page.waitForFunction(
    (min) => document.querySelectorAll(".journal-day .vr-outliner").length >= min,
    MIN_DAYS,
    { timeout: 300_000 },
  );
}

async function measureEdit() {
  await page.evaluate(() => {
    window.__longTasks = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks += e.duration;
    }).observe({ type: "longtask", buffered: false });
  });
  // A plain-text block: clicking a row that holds a link follows the link instead of editing.
  const target = page
    .locator(".journal-day:not(.journal-day-today) .vr-block-view:not(:has(a, [role='link']))")
    .first();
  await target.click({ position: { x: 4, y: 6 } });
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("End");
  for (let i = 0; i < EDITS; i++) {
    await page.keyboard.type("x");
    await page.waitForTimeout(900);
  }
  // A zero must mean "no long tasks", not "the keys went nowhere".
  const typed = await page.locator(".cm-content").innerText({ timeout: 2_000 });
  if (!typed.endsWith("x".repeat(EDITS))) throw new Error(`typing did not land: ${typed}`);
  for (let i = 0; i < EDITS; i++) await page.keyboard.press("Backspace");
  await page.waitForTimeout(900);
  const ms = Math.round(await page.evaluate(() => window.__longTasks));
  await page.keyboard.press("Escape");
  return ms;
}

// Warm-up: first visit bootstraps the replica when the profile is new.
const t0 = Date.now();
await page.goto(`${baseURL}/journals`);
await streamReady();
console.error(`[${label}] warm-up (bootstrap if first run): ${Date.now() - t0} ms`);
await page.waitForTimeout(3_000);

const load = [];
const edit = [];
const more = [];
const agendaRows = [];

for (let run = 0; run < RUNS; run++) {
  const start = Date.now();
  await page.reload();
  await streamReady();
  load.push(Date.now() - start);
  await page.waitForTimeout(1_500);
  agendaRows.push(await page.locator(".journal-agenda-item").count());

  if (!process.env.SKIP_EDIT) edit.push(await measureEdit());

  const before = await page.locator(".journal-day").count();
  const moreStart = Date.now();
  await page.locator(".journal-stream-sentinel").scrollIntoViewIfNeeded();
  await page.waitForFunction((n) => document.querySelectorAll(".journal-day").length > n, before, {
    timeout: 60_000,
  });
  more.push(Date.now() - moreStart);
}

console.log(
  JSON.stringify({
    label,
    runs: RUNS,
    loadMs: { median: median(load), all: load },
    editLongTaskMs: { median: median(edit), all: edit },
    loadMoreMs: { median: median(more), all: more },
    agendaRowsOnScreen: agendaRows,
  }),
);
await ctx.close();
