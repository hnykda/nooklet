/**
 * The desktop app's launcher page (`apps/desktop/launcher/`, B-430) in a real browser: what it
 * shows for what the app reports about its bundled server. Chromium, not the app's WKWebView —
 * this holds the page's wiring (the module import, the element ids, the polling), while the
 * wording for every state is `apps/desktop/test/launcher-status.test.mjs` and the Rust side's
 * exit detection is `cargo test` in `apps/desktop/src-tauri`.
 *
 * No nooklet server is involved. The page is served from a made-up origin through `page.route`,
 * `server_status` is a stub in `__TAURI_INTERNALS__` (what Tauri 2 injects), and every request to
 * the app's port is answered by the test — never by a real server on this machine's 6100.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const launcherDir = fileURLToPath(new URL("../../apps/desktop/launcher/", import.meta.url));
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../apps/desktop/test/server-status.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

// A loopback origin, like the app's own `tauri://localhost`: a public-looking one would put the
// page's fetch to 127.0.0.1 under Chromium's private-network rules, which the app never meets.
const ORIGIN = "http://localhost:6419";
const APP_SERVER = "http://127.0.0.1:6100";

/** Open the launcher with `status` as the app's answer; the app's server refuses connections until
 * `serverAnswers` is called. */
async function openLauncher(page: Page, status: unknown | "no-tauri") {
  let answering = false;
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: join(launcherDir, path === "/" ? "index.html" : path) });
  });
  await page.route(`${APP_SERVER}/**`, (route) =>
    answering
      ? route.fulfill({ contentType: "text/html", body: "<title>the app</title>the app" })
      : route.abort("connectionrefused"),
  );
  if (status !== "no-tauri") {
    await page.addInitScript((initial) => {
      const w = window as unknown as { __status: unknown; __TAURI_INTERNALS__: unknown };
      w.__status = initial;
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd !== "server_status") throw new Error(`unexpected command ${cmd}`);
          return w.__status;
        },
      };
    }, status);
  }
  await page.goto(`${ORIGIN}/`);
  return {
    serverAnswers: () => {
      answering = true;
    },
    setStatus: (next: unknown) =>
      page.evaluate((s) => {
        (window as unknown as { __status: unknown }).__status = s;
      }, next),
  };
}

test("a bundled server that refused a newer graph: the page says to update the app, and why", async ({
  page,
}) => {
  await openLauncher(page, fixtures.schema_too_new);
  await expect(page.locator("h1")).toHaveText("This graph needs a newer version of nooklet");
  await expect(page.locator("#message")).toContainText("Update the app");
  await expect(page.locator("#detail")).toHaveText(
    "nooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet",
  );
  // The old page's advice, wrong for an app that brings its own server.
  await expect(page.getByText("pnpm nooklet serve")).toBeHidden();
  await expect(page.locator("#help")).toBeHidden();
});

test("nothing spawned — the server the app was sharing went away: start it, then retry", async ({
  page,
}) => {
  await openLauncher(page, fixtures.external);
  await expect(page.locator("h1")).toHaveText("Couldn't reach the nooklet server");
  await expect(page.getByText("pnpm nooklet serve")).toBeVisible();
  await expect(page.locator("#problem")).toBeHidden();
});

test("outside the app (nobody to ask), the page still offers a server address", async ({
  page,
}) => {
  await openLauncher(page, "no-tauri");
  await expect(page.getByText("pnpm nooklet serve")).toBeVisible();
  await expect(page.locator("#url")).toHaveValue(APP_SERVER);
});

test("while the app's server starts the page says so, and opens nooklet once it answers", async ({
  page,
}) => {
  const launcher = await openLauncher(page, fixtures.starting);
  await expect(page.locator("#status")).toHaveText("Starting nooklet…");
  await expect(page.locator("#help")).toBeHidden();
  await expect(page.locator("#problem")).toBeHidden();

  // A slow start that then fails is reported as the failure, on the same page, with no reload.
  await launcher.setStatus(fixtures.port_in_use);
  await expect(page.locator("h1")).toHaveText("nooklet's port is taken");
  await expect(page.locator("#detail")).toContainText("EADDRINUSE");

  await launcher.setStatus(fixtures.ready);
  launcher.serverAnswers();
  await expect(page).toHaveURL(`${APP_SERVER}/`, { timeout: 10_000 });
});
