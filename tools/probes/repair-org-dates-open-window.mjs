/**
 * What does a window that is open during `nooklet repair org-dates --apply` see? (repair-agenda
 * verification, 2026-09-13.) OPERATIONS.md §10 said "quit the app first" and left this unchecked.
 *
 * Setup, never against ~/.nooklet/default: a `.backup` copy of the graph (unrepaired) in <dataDir>,
 * `nooklet token create --label probe --scope write --data <dataDir>` saved to <tokenFile>, and
 * `nooklet serve --data <dataDir> --port <port>` running with this checkout's production build.
 * The probe opens /page/2023-02-17 in context A, runs the repair from this checkout as its own
 * process against the same database while the server keeps running, watches A without a reload,
 * reloads A, opens a fresh context B, then `POST /api/v1/batch.undo`s the printed batch_id and
 * watches both.
 *
 * Usage: NOOKLET_DATA=<scratch> node tools/probes/repair-org-dates-open-window.mjs <baseURL> <dataDir> <tokenFile>
 *
 * Result when written (owner's graph copy, 20 blocks, 19 on 2023-02-17):
 *   A before            26 rows, 0 chips, 19 rows with SCHEDULED: text
 *   repair --apply      succeeded while `serve` ran: 20 blocks, 40 ops, one batch_id (no SQLITE_BUSY)
 *   A, no reload, 15 s  unchanged — 0 chips, 19 SCHEDULED: rows. The server never hears about a
 *                       write another process made, so it pokes no client.
 *   A after reload      19 chips, 0 SCHEDULED: rows (the replica pulled on start)
 *   B fresh context     19 chips, 0 SCHEDULED: rows
 *   batch.undo (HTTP)   200; A and B back to 0 chips / 19 SCHEDULED: rows live, within ~0.5 s
 *   console errors      none
 * The running server's live mirror also stays stale for those pages until `serve` restarts (its
 * first sweep renders every page) or the pages are written again through it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const [base, dataDir, tokenFile] = process.argv.slice(2);
if (!base || !dataDir || !tokenFile || !process.env.NOOKLET_DATA) {
  console.error(
    "usage: NOOKLET_DATA=<scratch> repair-org-dates-open-window.mjs <baseURL> <dataDir> <tokenFile>",
  );
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
const serverDir = fileURLToPath(new URL("../../packages/server", import.meta.url));
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const errors = [];
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  return page;
}
const state = (page) =>
  page.evaluate(() => ({
    rows: document.querySelectorAll(".vr-row").length,
    chips: document.querySelectorAll(".vr-date").length,
    schedText: [...document.querySelectorAll(".vr-row")].filter((r) =>
      r.textContent.includes("SCHEDULED:"),
    ).length,
  }));
async function waitFor(page, pred, ms) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < ms) {
    s = await state(page);
    if (pred(s)) return { ...s, after: Date.now() - t0 };
    await page.waitForTimeout(500);
  }
  return { ...s, after: "timeout" };
}

const a = await open("A");
await a.goto(`${base}/page/2023-02-17`);
await a.locator(".vr-row").first().waitFor({ timeout: 180_000 });
log("A before", await waitFor(a, (s) => s.schedText > 0, 60_000));

let out;
try {
  out = execFileSync(
    "npx",
    ["tsx", "src/cli.ts", "repair", "org-dates", "--apply", "--data", dataDir],
    {
      cwd: serverDir,
      encoding: "utf8",
    },
  );
} catch (e) {
  out = `FAILED ${e.status}: ${e.stdout}\n${e.stderr}`;
}
log("repair:", out.split("\n").slice(-3).join(" | "));
const batch = /batch_id (\w+)/.exec(out)?.[1];

log("A live, no reload", await waitFor(a, (s) => s.chips > 0 && s.schedText === 0, 15_000));
await a.reload();
await a.locator(".vr-row").first().waitFor({ timeout: 60_000 });
log("A after reload", await waitFor(a, (s) => s.chips > 0 && s.schedText === 0, 30_000));

const b = await open("B");
await b.goto(`${base}/page/2023-02-17`);
await b.locator(".vr-row").first().waitFor({ timeout: 180_000 });
log("B fresh", await waitFor(b, (s) => s.chips > 0 && s.schedText === 0, 60_000));

const r = await fetch(`${base}/api/v1/batch.undo`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ batch_id: batch }),
});
log("undo", r.status);
log("A after undo", await waitFor(a, (s) => s.schedText > 0 && s.chips === 0, 20_000));
log("B after undo", await waitFor(b, (s) => s.schedText > 0 && s.chips === 0, 20_000));
log("errors", errors);
await browser.close();
