/**
 * The site's browser tests: real Chromium against the real static export in `out/`, served the
 * way production serves it (`scripts/serve.ts` mirrors the nginx `try_files` rule).
 *
 *   pnpm --filter @nooklet/site build
 *   pnpm --filter @nooklet/site e2e
 */

import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.SITE_E2E_PORT ?? 6448);

export default defineConfig({
  testDir: ".",
  outputDir: `../../../test-results/site-${port}`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/serve.ts out ${port}`,
    cwd: "..",
    url: `http://127.0.0.1:${port}/llms.txt`,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
