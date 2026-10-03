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

const port = process.env.NOOKLET_E2E_PORT ?? "6188";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // Artifacts are keyed by port like the server's state file, because the port is what separates
  // concurrent runs (several agents on one checkout). With one shared `test-results/`, run A's
  // start-up wipe deleted run B's in-flight trace dir and B failed at `browserContext.close` with
  // ENOENT — a spurious failure that cost real investigation time more than once.
  outputDir: `./test-results/${port}`,
  // Each spec gets its own server + data dir (see global-setup), so tests within a file share
  // state; running files in parallel against one server would make assertions on "the journal"
  // order-dependent.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? "list"
    : [["list"], ["html", { open: "never", outputFolder: `./playwright-report/${port}` }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    // Derived from NOOKLET_E2E_PORT, the same knob `global-setup.ts` starts the server on. These
    // used to be independent: setting only the port moved the server and left the browser pointing
    // at 6188, where another agent's dev server was happily answering with last week's code. A
    // whole afternoon of "but it works when I curl it" lives in this line.
    baseURL: process.env.NOOKLET_E2E_URL ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // WebKit runs a few specs, not the suite: the storage fallback (B-43). Its build has no OPFS
    // inside workers, so the whole suite would run against an in-memory replica — a different app
    // from the one shipped — and the Mac app's WKWebView, which does have OPFS, is what WebKit
    // coverage would be for anyway. This keeps the engine exercised without pretending it is a
    // faithful stand-in. Also the specs for a bug reported from the Mac app only (B-42): focus
    // across a sync refresh with the `[[` popup open, and the focus log that records it there —
    // an in-memory replica changes nothing about focus. And the caret across a move of the row
    // being edited, which WebKit alone lost (B-501, B-502). And `ref-label-flash` (B-500): what a refresh
    // leaves on screen between two renders does not depend on the storage tier. And where a click or
    // End puts the caret around a hidden `]]` (B-606): hit testing is the engine's own.
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch:
        /(storage|webkit-refresh-focus|focus-log|edited-row-move-caret|ref-label-flash|caret-after-link)\.spec\.ts/,
    },
  ],
});
