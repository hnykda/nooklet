/**
 * A new build reaches a page that is already open (B-532).
 *
 * The service worker is what serves the client, so "the client updates" means: a newer worker
 * installs, TAKES OVER the page an older worker controls, and the page reloads onto it. B-20 set
 * vite-plugin-pwa to autoUpdate for exactly that, but `injectRegister: false` quietly disabled the
 * plugin's `skipWaiting`/`clientsClaim`, so the newer worker installed and then waited for every
 * page to close. The desktop app showed the previous client for a whole session after each update
 * (`tools/probes/desktop-sw-update.sh`); a browser tab never updated at all.
 *
 * "A newer worker" is simulated by registering this build's own `sw.js` under another script URL:
 * to the browser that is an update of the registration like any other, and it runs the exact
 * worker code the build ships — which is the thing under test.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

interface SwState {
  controlled: boolean;
  scriptURL: string | null;
  waiting: boolean;
  installing: boolean;
}

async function swState(page: import("@playwright/test").Page): Promise<SwState | null> {
  try {
    return await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        controlled: navigator.serviceWorker.controller !== null,
        scriptURL: navigator.serviceWorker.controller?.scriptURL ?? null,
        waiting: !!reg?.waiting,
        installing: !!reg?.installing,
      };
    });
  } catch {
    return null; // mid-reload: the execution context went away under us
  }
}

test("a newer service worker takes over an open page and reloads it onto the new build (B-532)", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // Make sure the page is CONTROLLED by the first worker — the situation of every launch after the
  // first. (Reloading is how an uncontrolled page becomes controlled without `clientsClaim`.)
  await page.reload();
  await expect.poll(() => swState(page).then((s) => s?.controlled), { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".app-topbar")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __beforeUpdate: boolean }).__beforeUpdate = true;
  });
  const reloaded = page.waitForEvent("load", { timeout: 60_000 });
  await page
    .evaluate(() =>
      navigator.serviceWorker
        .register("/sw.js?e2e-next-build", { scope: "/" })
        .then(() => undefined),
    )
    .catch(() => {}); // the reload this test waits for can land before `register` settles

  // The page reloads by itself — no tab closed, no user action. Before the fix it never did: the new
  // worker sat in `waiting`, which the failure message shows.
  await reloaded.catch(async (err) => {
    throw new Error(
      `no reload onto the new worker; state: ${JSON.stringify(await swState(page))}\n${err}`,
    );
  });
  // And it ends up running under a worker with nothing left waiting behind it. (The reloaded app
  // registers `/sw.js` again, which is one more update of the same kind, so poll for the settled
  // state rather than asserting on one script URL.)
  await expect
    .poll(() => swState(page), { timeout: 60_000 })
    .toMatchObject({ controlled: true, waiting: false, installing: false });
  expect(
    await page.evaluate(
      () => (window as unknown as { __beforeUpdate?: boolean }).__beforeUpdate ?? false,
    ),
  ).toBe(false);
  await expect(page.locator(".app-topbar")).toBeVisible();
});

test("a newer worker that takes the page over before the page registered its own still reloads it (B-537)", async ({
  page,
}) => {
  await page.goto("/journals");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => swState(page).then((s) => s?.controlled), { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".app-topbar")).toBeVisible();

  // The desktop app's slow start, made deterministic: `/api/session` does not answer, so `main.tsx`
  // never reaches `registerServiceWorker()` — the state WebKit's soft update (one second after the
  // navigation) finds a page in when the session request is slow.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/session", async (route) => {
    await gate;
    await route.continue().catch(() => {}); // the request of a document that has since reloaded
  });
  const sessionRequested = page.waitForRequest("**/api/session");
  await page.reload({ waitUntil: "commit" });
  await sessionRequested;
  await page.evaluate(() => {
    (window as unknown as { __beforeTakeover: boolean }).__beforeTakeover = true;
  });

  // A newer worker installs and claims the page (this build's worker, as in the test above).
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  await page
    .evaluate(() =>
      navigator.serviceWorker
        .register("/sw.js?e2e-next-build", { scope: "/" })
        .then(() => undefined),
    )
    .catch(() => {});
  // The reload must come while the session request is STILL held: nothing in the bundle has
  // registered yet, so only the listener in index.html can have done it. (Without it the page did
  // reload — but only after the session answered and registerSW found a script URL to update.)
  await reloaded.catch((err) => {
    throw new Error(`no reload while /api/session was held; state: ${String(err)}`);
  });
  expect(
    await page
      .evaluate(
        () => (window as unknown as { __beforeTakeover?: boolean }).__beforeTakeover ?? false,
      )
      .catch(() => false),
  ).toBe(false);

  release();
  await page.unroute("**/api/session");
  await expect(page.locator(".app-topbar")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => swState(page), { timeout: 60_000 })
    .toMatchObject({ controlled: true, waiting: false, installing: false });
});
