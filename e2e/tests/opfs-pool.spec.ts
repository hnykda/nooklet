/**
 * The replica's OPFS file pool, as a first start that was cut short leaves it (B-323).
 *
 * `opfs-sahpool` keeps a fixed pool of OPFS files and gives SQLite one per file it opens — the
 * database, and its rollback journal on the first write. sqlite-wasm fills the pool (six files)
 * only when it finds it EMPTY, one file at a time, asynchronously. A load torn down in the middle
 * of that — a reload, a navigation, a closed tab in the first tenth of a second of the app's first
 * start in this browser — leaves one to five files, and no later start ever tops it up. With one,
 * the database took the only slot, the journal could not be opened ("SAH pool is full. Cannot
 * create file /nooklet.sqlite3-journal"), creating the schema failed with SQLITE_CANTOPEN, the DB
 * worker never came up, and every view sat on "Loading…" — on every start from then on, since the
 * pool lives in OPFS. Found by `references.spec.ts` under load, where its `goto("/journals")` was
 * followed ~90 ms later by a second `goto` (the trace had no `/sync/snapshot` request at all).
 *
 * The timing is not reproducible on demand, so this test builds the state it leaves directly: the
 * pool's directory with ONE opaque file, created from a same-origin document that does not start
 * the app, before the app ever runs. A zero-length file is exactly what a worker killed between
 * creating the file and writing its header leaves; sqlite-wasm reads it as one free slot.
 */

import { expect, test } from "@playwright/test";
import { pagePath, runName, seedPage } from "../helpers/index.js";

test("a start cut short while the OPFS pool was being created does not leave the app dead", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const name = runName("Opfs Pool Survivor", info);
  await seedPage(page, name, "- still here");

  // Any same-origin document that is not the app will do; the icon is a static file.
  await page.goto("/icon.svg");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    // `db/sqlite-wasm-driver.ts` names the VFS "nooklet-opfs-sahpool"; sqlite-wasm keeps its
    // pool in "." + that name, with the files themselves in ".opaque".
    const vfs = await root.getDirectoryHandle(".nooklet-opfs-sahpool", { create: true });
    const opaque = await vfs.getDirectoryHandle(".opaque", { create: true });
    await opaque.getFileHandle("interruptedslot", { create: true });
  });

  await page.goto(pagePath(name));
  const outliner = page.locator(".vr-outliner").first();
  await expect(outliner).toContainText("still here");
  // On OPFS, not quietly on the in-memory fallback: the fix is that the pool is usable, not that
  // something else took over. Anchored: "synced via another tab" is an in-memory follower (B-81)
  // and an unanchored /synced/ let it pass.
  await expect(page.locator(".app-sync-indicator")).toHaveText(/^(synced|syncing \(\d+\))$/);

  // And it writes: the rollback journal is exactly the file there was no room for.
  await outliner.locator(".vr-block-view").first().click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" and writable", { delay: 20 });
  await page.reload();
  await expect(page.locator(".vr-outliner").first()).toContainText("still here and writable");
  expect(errors).toEqual([]);
});
