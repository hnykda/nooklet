/**
 * Captures the landing page screenshots from the real app, running on a throwaway copy of
 * `demo-graph/` (invented demo notes, never anyone's real graph).
 *
 *   pnpm --filter @nooklet/web build            # the server serves this build
 *   pnpm --filter @nooklet/site screenshots
 *
 * It imports the demo graph into a temp data dir, starts `nooklet serve` on port 6447, takes each
 * shot in light and dark, writes `public/screenshots/*.png`, and stops the server. The journal
 * files are dated around 2026-10-04: run it on another day and "Today" will be an empty new day
 * above them, so rename the files first if that matters.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const site = process.cwd();
const repo = resolve(site, "../..");
const port = 6447;
const base = `http://127.0.0.1:${port}`;
const outDir = join(site, "public", "screenshots");
const data = mkdtempSync(join(tmpdir(), "nooklet-site-shots-"));

const require = createRequire(join(repo, "package.json"));
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");

function nooklet(args: string[]) {
  return ["--filter", "@nooklet/server", "exec", "tsx", "src/cli.ts", ...args];
}

const imported = spawnSync("pnpm", nooklet(["import", join(site, "demo-graph"), "--data", data]), {
  cwd: repo,
  stdio: "inherit",
});
if (imported.status !== 0) throw new Error("import of demo-graph failed");

const server = spawn("pnpm", nooklet(["serve", "--data", data, "--port", String(port)]), {
  cwd: repo,
  stdio: "ignore",
  detached: true,
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok || (await fetch(base)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server never answered on ${base}`);
}

const SHOTS = [
  { name: "page", path: "/g/default/page/Garden%20shed" },
  { name: "journal", path: "/g/default/journals" },
];

try {
  await waitForServer();
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    const page = await ctx.newPage();
    for (const shot of SHOTS) {
      await page.goto(`${base}${shot.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      // Park the pointer and caret so no hover state or blinking cursor lands in the picture.
      await page.mouse.move(0, 799);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({ path: join(outDir, `${shot.name}-${scheme}.png`) });
      console.log(`wrote ${shot.name}-${scheme}.png`);
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  if (server.pid) process.kill(-server.pid, "SIGTERM");
  rmSync(data, { recursive: true, force: true });
}
