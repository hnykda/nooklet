/**
 * Device-readiness sweep (docs/review/2026-10-03-sweep-devices.md). NOT part of `pnpm e2e`: it
 * drives a server started by hand with `serve.sh` (bound to this Mac's LAN IP so every browser is a
 * genuine NON-loopback client and gets no token injected — the real phone / second-Mac situation).
 *
 *   SWEEP_BASE=http://192.168.1.5:6311 SWEEP_TOKENS=tokens.json \
 *     pnpm exec playwright test -c tools/probes/sweep-devices/playwright.config.ts
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.probe\.ts/,
  outputDir: "/tmp/nooklet-sweep-devices-results",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", headless: true },
});
