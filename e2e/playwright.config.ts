/**
 * End-to-end tests: a real Chromium against a real `nooklet serve` serving the real production
 * build of the client.
 *
 * Why this exists: the unit and component suites (1,180 tests, all green) never launched a
 * browser and never went through a production build, so an entire class of defect was invisible
 * to them — the served client having no API credential, a `<For>` keyed on rebuilt objects tearing
 * out the editor on every keystroke, a rejected fetch rendering as a permanent spinner. Every one
 * of those passed CI and broke on first real use. These tests are the cheapest thing that would
 * have caught them.
 *
 * The web server is started by `globalSetup` rather than Playwright's `webServer` option because
 * it needs to build the client, seed a throwaway graph, and hand the port back — see `global-setup.ts`.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // Each spec gets its own server + data dir (see global-setup), so tests within a file share
  // state; running files in parallel against one server would make assertions on "the journal"
  // order-dependent.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    // Derived from NOOKLET_E2E_PORT, the same knob `global-setup.ts` starts the server on. These
    // used to be independent: setting only the port moved the server and left the browser pointing
    // at 6188, where another agent's dev server was happily answering with last week's code. A
    // whole afternoon of "but it works when I curl it" lives in this line.
    baseURL:
      process.env.NOOKLET_E2E_URL ?? `http://127.0.0.1:${process.env.NOOKLET_E2E_PORT ?? 6188}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
