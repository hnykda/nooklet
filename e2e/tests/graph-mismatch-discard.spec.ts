/**
 * B-631: "Discard the local copy and re-sync" (`views/GraphMismatchView.tsx`) deletes the
 * mismatched graph's replica and nothing else. It used to remove every OPFS entry — the
 * `opfs-sahpool` directory holds EVERY graph's replica on the device — so a local-only graph's
 * notes, which exist nowhere else, were lost with it.
 *
 * Set-up: `../helpers/graph-mismatch.ts`. B-714's other two choices: `graph-mismatch-choices.spec.ts`.
 */

import { expect, test } from "@playwright/test";
import {
  capacitorContext,
  connectFromSetup,
  createGraph,
  hits,
  MISMATCH_HEADING,
  marker,
  rememberAnEarlierGraph,
  today,
  typeToday,
  waitForWritesApplied,
} from "../helpers/graph-mismatch.js";
import { openGraphMenu } from "../helpers/index.js";

test("B-631: discarding a mismatched graph's local copy keeps every other graph's replica", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(3 * 60_000);
  const base = baseURL as string;
  const graphId = `gm-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const localNote = marker("gmlocal");
  const syncedNote = marker("gmsynced");
  const unsyncedNote = marker("gmunsynced");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  // 1. A local-only graph with a note: it exists on this device and nowhere else.
  await page.goto(`${base}/journals`);
  await page.getByRole("button", { name: /Just this device/s }).click();
  await typeToday(page, localNote);
  await waitForWritesApplied(page);

  // 2. A server graph next to it, with a note the server has.
  await openGraphMenu(page);
  await page.getByText("Add a graph").click();
  await page.getByRole("button", { name: /Sync with a server/s }).click();
  await page.getByLabel("Server address").fill(`${base}/g/${graphId}`);
  await page.getByLabel("Device token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await typeToday(page, syncedNote);
  await expect.poll(() => hits(base, graphId, token, syncedNote), { timeout: 15_000 }).toBe(1);

  // 3. A note only in the server graph's replica (sync held off): it must go with the discard,
  //    which is how this test knows the replica really was deleted, not just left alone.
  //    Held off until the discard is done — the mismatched page's own worker would push it.
  await page.route(`**/g/${graphId}/sync/**`, (route) => route.abort());
  await typeToday(page, unsyncedNote);
  await waitForWritesApplied(page);

  // 4. The mismatch: this entry remembers a different graph than the server now reports.
  const entryId = await rememberAnEarlierGraph(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible();

  // 5. Discard. B-714: the copy has an unsynced change, so the screen says so, recommends keeping
  //    it, and asks once more before the discard.
  await expect(page.getByTestId("mismatch-unsynced")).toContainText(
    /[1-9]\d* changes? that never reached a server/,
  );
  await expect(page.getByText("Recommended")).toBeVisible();
  await page.getByRole("button", { name: "Discard the local copy and re-sync" }).click();
  await expect(page.getByRole("alert")).toContainText("will be lost for good");
  await page.getByRole("button", { name: "Discard and lose the changes" }).click();
  await expect(page.locator(".connect")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await hits(base, graphId, token, unsyncedNote)).toBe(0);
  await page.unroute(`**/g/${graphId}/sync/**`);
  await page.reload();

  // 6. The server graph re-synced from scratch: the server's note is back, the never-synced one
  //    went with the deleted replica.
  await expect(page.locator(".app-sync-indicator")).toHaveAttribute("data-state", "synced", {
    timeout: 20_000,
  });
  await expect(today(page)).toContainText(syncedNote, { timeout: 15_000 });
  await expect(today(page)).not.toContainText(unsyncedNote);
  expect(
    await page.evaluate(
      (id) =>
        (
          JSON.parse(localStorage.getItem("nooklet.graphs") ?? "[]") as {
            id: string;
            graphInstanceId?: string;
          }[]
        ).find((g) => g.id === id)?.graphInstanceId,
      entryId,
    ),
  ).not.toBe("an-earlier-graph-instance");

  // 7. The local-only graph's note is still there.
  await openGraphMenu(page);
  // B-644: the local graph has a generated name now; it is the row with no server address.
  await page
    .locator(".graph-switcher-row")
    .filter({ hasNot: page.locator(".graph-switcher-address") })
    .locator(".graph-switcher-name")
    .click();
  await expect(today(page)).toContainText(localNote, { timeout: 15_000 });
  expect(await hits(base, graphId, token, localNote)).toBe(0);
  await ctx.close();
});

test("B-633: while the mismatch screen shows, the old replica does not sync with the server's graph", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(2 * 60_000);
  const base = baseURL as string;
  const graphId = `gm33-${Date.now().toString(36)}`;
  const token = await createGraph(base, graphId);
  const unsyncedNote = marker("gm33unsynced");
  const ctx = await capacitorContext(browser, base);
  const page = await ctx.newPage();

  await page.goto(`${base}/journals`);
  await connectFromSetup(page, base, graphId, token);

  // A pending op the server has not seen (sync held off while it is written).
  await page.route(`**/g/${graphId}/sync/**`, (route) => route.abort());
  await typeToday(page, unsyncedNote);
  await waitForWritesApplied(page);

  // The mismatch, then sync open again: only the fix stands between the pending op and the
  // server's (different) graph now.
  await rememberAnEarlierGraph(page);
  await page.unroute(`**/g/${graphId}/sync/**`);
  const syncRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(`/g/${graphId}/sync/`)) syncRequests.push(req.url());
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: MISMATCH_HEADING })).toBeVisible();

  // Long enough for a worker that does sync to have pushed (it pushes within a second or two).
  await page.waitForTimeout(5_000);
  expect(await hits(base, graphId, token, unsyncedNote)).toBe(0);
  expect(syncRequests).toEqual([]);
  await ctx.close();
});
