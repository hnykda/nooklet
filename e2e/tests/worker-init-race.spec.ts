/**
 * B-582: every worker-backed call in `db/client.ts` (`query`, `getPageTree`, `getJournalStream`,
 * `nextHlc`, `getDeviceId`, `applyOps`, `getSyncStatus`, `forceSync`) used to call `getWorker()`
 * directly — which only lazily creates the `Worker`/Comlink proxy, saying nothing about whether
 * `WorkerApi.init()` has actually been dispatched and applied. `main.tsx` calls `initDb(...)` and
 * renders `<App/>` in the same tick without awaiting it, so the very first render's resources
 * raced `init()` — a race that was winning by luck until Option C's `readCheckpoint()` step added
 * one more microtask hop before `api.init(...)` is even dispatched, which made it reliably lose:
 * every worker call from a first render threw `WorkerApi.init() must be called before any other
 * method`, an uncaught error that silently prevented Solid from rendering the affected subtree —
 * which is why the reported symptom was "the sidebar toggle button does nothing" rather than an
 * obviously worker-wide failure (`Sidebar.tsx`'s data — `useFavoritePages`/`useAllPages`/
 * `usePageIcons` — happened to be what a real repro exercised, but this affected any first-render
 * worker call, not the sidebar specifically).
 *
 * This is exactly the class of bug `CLAUDE.md` warns a unit suite cannot catch on its own — the
 * race only manifests against a real Worker/Comlink boundary, which nothing in `apps/web`'s vitest
 * suite exercises (see `db/sqlite-wasm-driver.ts`'s own header: "NOT unit tested — OPFS/WASM only
 * exist in a real browser").
 */
import { expect, test } from "@playwright/test";

test("the sidebar opens on first click, with no page errors from a worker-init race", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/journals");
  await expect(page.locator(".app-sidebar")).toHaveCount(0);

  await page.locator("button[aria-label='Toggle sidebar']").click();
  await expect(page.locator(".app-sidebar")).toBeVisible({ timeout: 3000 });

  expect(pageErrors).toEqual([]);
});
