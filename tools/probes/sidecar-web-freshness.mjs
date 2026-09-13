/**
 * Does `apps/desktop/build-sidecar.mjs` ship the web client built from THIS checkout, or whatever
 * `apps/web/dist` happened to hold? (B-337)
 *
 *   node tools/probes/sidecar-web-freshness.mjs
 *
 * Plants a stale client in `apps/web/dist` — an `index.html` saying so and a marker file, the way a
 * build from another branch or an e2e run on another tree state leaves it — runs the sidecar build,
 * and checks what landed in `apps/desktop/sidecar/web`. At `70c9bb9` the script built the client
 * only when `dist/index.html` was missing, so it copied the planted one: this printed
 * `STALE: sidecar/web/index.html is the planted one` and exited 1. Exits 0 when the sidecar's
 * client is a fresh build.
 *
 * Rewrites `apps/web/dist` and `apps/desktop/sidecar` (both build output, both git-ignored).
 * Needs the Node runtime in `apps/desktop/.cache` or network access (the sidecar build fetches it).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dist = join(repoRoot, "apps", "web", "dist");
const sidecarWeb = join(repoRoot, "apps", "desktop", "sidecar", "web");
const STALE = "<!doctype html><title>stale build planted by sidecar-web-freshness</title>";

mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), STALE);
writeFileSync(join(dist, "STALE-MARKER"), "left by an older build\n");

const r = spawnSync("node", [join(repoRoot, "apps", "desktop", "build-sidecar.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (r.status !== 0) {
  console.log(`sidecar build failed (${r.status})`);
  process.exit(2);
}

const html = readFileSync(join(sidecarWeb, "index.html"), "utf8");
const problems = [];
if (html === STALE) problems.push("sidecar/web/index.html is the planted one");
if (existsSync(join(sidecarWeb, "STALE-MARKER"))) problems.push("sidecar/web holds the marker");
if (!/<script[^>]+src="\/static\/index-[^"]+\.js"/.test(html)) {
  problems.push("sidecar/web/index.html does not load a built /static/index-*.js");
}
if (problems.length > 0) {
  console.log(`STALE: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("fresh: sidecar/web is a client built by this run");
