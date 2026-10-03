/**
 * Probes for docs/progress/local-graphs.md (B-611, B-612, B-619). NOT part of `pnpm e2e`. They
 * drive the app served by `../sweep-devices/host-proxy.mjs` in static mode (a same-origin stand-in
 * for the Capacitor shell) in front of a scratch `nooklet serve`:
 *
 *   ../sweep-devices/serve.sh <scratch-dir> 6335
 *   node ../sweep-devices/host-proxy.mjs 6336 6335 nooklet.sweep.test <repo>/apps/web/dist
 *   LG_APP=http://127.0.0.1:6336 pnpm exec playwright test -c tools/probes/local-graphs/playwright.config.ts
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.probe\.ts/,
  outputDir: "/tmp/nooklet-local-graphs-probe-results",
  workers: 1,
  fullyParallel: false,
  timeout: 900_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { headless: true },
});
