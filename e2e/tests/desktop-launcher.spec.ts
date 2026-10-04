/**
 * The desktop app's launcher page (`apps/desktop/launcher/`, B-430; since ADR 032 only
 * "Connecting…") in a real browser: what it shows while the graph its window was opened for
 * (`__NOOKLET_DESKTOP__.connect`) comes up or doesn't. Chromium, not the app's WKWebView — this
 * holds the page's wiring (the module import, the element ids, the polling), while the wording for
 * every bundled-server state is `apps/desktop/test/launcher-status.test.mjs` and the Rust side's
 * exit detection is `cargo test` in `apps/desktop/src-tauri`.
 *
 * No nooklet server is involved. The page is served from a made-up origin through `page.route`,
 * `server_status` is a stub in `__TAURI_INTERNALS__` (what Tauri 2 injects), and every request to
 * the app's port or the remote server is answered by the test — never by a real server.
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
const REMOTE = "https://notes.example.com";

interface Target {
  url: string;
  place: "mac" | "server";
  label: string;
}

/** Open the launcher with `status` as the app's answer and `connect` as the window's target. Both
 * servers refuse connections until `answers(...)` says otherwise. */
async function openLauncher(page: Page, status: unknown | "no-tauri", connect?: Target) {
  const up = new Set<string>();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: join(launcherDir, path === "/" ? "index.html" : path) });
  });
  for (const origin of [APP_SERVER, REMOTE]) {
    await page.route(`${origin}/**`, (route) =>
      up.has(origin)
        ? route.fulfill({ contentType: "text/html", body: "<title>the app</title>the app" })
        : route.abort("connectionrefused"),
    );
  }
  if (status !== "no-tauri") {
    await page.addInitScript(
      ([initial, target]) => {
        const w = window as unknown as {
          __status: unknown;
          __invoked: string[];
          __TAURI_INTERNALS__: unknown;
          __NOOKLET_DESKTOP__?: unknown;
        };
        w.__status = initial;
        w.__invoked = [];
        w.__NOOKLET_DESKTOP__ = Object.freeze({
          platform: "macos",
          port: 6100,
          key: "k",
          graphs: [],
          graphToken: null,
          connect: target,
        });
        w.__TAURI_INTERNALS__ = {
          invoke: async (cmd: string) => {
            w.__invoked.push(cmd);
            if (cmd === "server_status") return w.__status;
            throw new Error(`unexpected command ${cmd}`);
          },
        };
      },
      [status, connect ?? null] as const,
    );
  }
  await page.goto(`${ORIGIN}/`);
  return {
    answers: (origin: string) => up.add(origin),
    setStatus: (next: unknown) =>
      page.evaluate((s) => {
        (window as unknown as { __status: unknown }).__status = s;
      }, next),
    invoked: () => page.evaluate(() => (window as unknown as { __invoked: string[] }).__invoked),
  };
}

const MAC_TARGET: Target = { url: `${APP_SERVER}/g/default`, place: "mac", label: "This Mac" };
const SERVER_TARGET: Target = { url: `${REMOTE}/g/work`, place: "server", label: "Work" };

test("a bundled server that refused a newer graph: the page says to update the app, and why", async ({
  page,
}) => {
  await openLauncher(page, fixtures.schema_too_new, MAC_TARGET);
  await expect(page.locator("#title")).toHaveText("This graph needs a newer version of nooklet");
  await expect(page.locator("#message")).toContainText("Update the app");
  await expect(page.locator("#detail")).toHaveText(
    "nooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet",
  );
  // Advice for someone running a server by hand, wrong for an app that brings its own.
  await expect(page.getByText("pnpm nooklet serve")).toBeHidden();
  // On This Mac there is nowhere else to go.
  await expect(page.getByRole("button", { name: "Open a graph on this Mac" })).toBeHidden();
});

test("nothing spawned — the server the app was sharing went away: start it, then try again", async ({
  page,
}) => {
  await openLauncher(page, fixtures.external, MAC_TARGET);
  await expect(page.locator("#title")).toHaveText("Couldn't reach the nooklet server");
  await expect(page.getByText("pnpm nooklet serve")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("outside the app (nobody to ask) it waits for This Mac's default graph", async ({ page }) => {
  await openLauncher(page, "no-tauri");
  await expect(page.getByText("pnpm nooklet serve")).toBeVisible();
});

test("while This Mac's server starts the page says so, and opens the graph once it answers", async ({
  page,
}) => {
  const launcher = await openLauncher(page, fixtures.starting, {
    url: `${APP_SERVER}/g/quiet-otter`,
    place: "mac",
    label: "Quiet Otter",
  });
  await expect(page.locator("#status")).toHaveText("Starting nooklet…");
  await expect(page.locator("#problem")).toBeHidden();

  // A slow start that then fails is reported as the failure, on the same page, with no reload.
  await launcher.setStatus(fixtures.port_in_use);
  await expect(page.locator("#title")).toHaveText("nooklet's port is taken");
  await expect(page.locator("#detail")).toContainText("EADDRINUSE");

  await launcher.setStatus(fixtures.ready);
  launcher.answers(APP_SERVER);
  await expect(page).toHaveURL(`${APP_SERVER}/g/quiet-otter`, { timeout: 10_000 });
});

test("B-785: a server graph that answers opens at once, without asking about the bundled server", async ({
  page,
}) => {
  const launcher = await openLauncher(page, fixtures.starting, SERVER_TARGET);
  launcher.answers(REMOTE);
  await expect(page).toHaveURL(`${REMOTE}/g/work`, { timeout: 10_000 });
  expect(await launcher.invoked()).toEqual([]);
});

test("proposal 005: a server graph that doesn't answer: Couldn't reach <server>, Try again, Open a graph on this Mac", async ({
  page,
}) => {
  const launcher = await openLauncher(page, fixtures.ready, SERVER_TARGET);
  await expect(page.locator("#title")).toHaveText("Couldn't reach notes.example.com.");
  await expect(page.locator("#message")).toContainText("“Work” is on that server");
  await expect(page.getByText("pnpm nooklet serve")).toBeHidden();
  // No list and no add form here any more: those are the app's graph menu.
  await expect(page.locator("input")).toHaveCount(0);

  // Try again, still down: still the same words; then up: it opens.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#title")).toHaveText("Couldn't reach notes.example.com.");
  launcher.answers(REMOTE);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(`${REMOTE}/g/work`, { timeout: 10_000 });
});

test("proposal 005: from an unreachable server, Open a graph on this Mac goes to This Mac's default graph", async ({
  page,
}) => {
  const launcher = await openLauncher(page, fixtures.ready, SERVER_TARGET);
  launcher.answers(APP_SERVER);
  await page.getByRole("button", { name: "Open a graph on this Mac" }).click();
  await expect(page).toHaveURL(`${APP_SERVER}/g/default`);
});
