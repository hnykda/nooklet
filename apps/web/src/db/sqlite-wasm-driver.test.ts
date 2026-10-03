/**
 * `shouldRestoreCheckpoint` only — the rest of this file needs real OPFS/WASM (see its own header)
 * and is exercised manually per `apps/web/README.md`'s browser-verification list.
 */
import { describe, expect, it } from "vitest";
import { discardReplicaFile, shouldRestoreCheckpoint } from "./sqlite-wasm-driver.js";

describe("discardReplicaFile (B-631: discard one graph's replica, not the device's)", () => {
  /** A pool holding several graphs' replicas, the way one device's `opfs-sahpool` does. */
  function fakePool(names: string[]) {
    const files = new Set(names);
    const events: string[] = [];
    return {
      files,
      events,
      unlink(name: string): boolean {
        events.push(`unlink ${name}`);
        return files.delete(name);
      },
    };
  }

  it("removes only the named replica (and its journal), closing it first", () => {
    const pool = fakePool([
      "/nooklet.sqlite3", // the un-namespaced replica: a local-only graph's notes
      "/nooklet-aaa.sqlite3",
      "/nooklet-aaa.sqlite3-journal",
      "/nooklet-bbb.sqlite3",
    ]);
    const db = { close: () => void pool.events.push("close") };
    const removed = discardReplicaFile(pool, db, "/nooklet-aaa.sqlite3");
    expect(removed).toEqual(["/nooklet-aaa.sqlite3", "/nooklet-aaa.sqlite3-journal"]);
    expect([...pool.files].sort()).toEqual(["/nooklet-bbb.sqlite3", "/nooklet.sqlite3"]);
    expect(pool.events[0]).toBe("close");
  });

  it("the un-namespaced replica's name never takes a namespaced one with it", () => {
    const pool = fakePool(["/nooklet.sqlite3", "/nooklet-aaa.sqlite3"]);
    discardReplicaFile(pool, { close() {} }, "/nooklet.sqlite3");
    expect([...pool.files]).toEqual(["/nooklet-aaa.sqlite3"]);
  });
});

describe("shouldRestoreCheckpoint (Option C's restore decision)", () => {
  it("restores into a pool with nothing under this name, when a checkpoint exists", () => {
    expect(shouldRestoreCheckpoint([], "/nooklet.sqlite3", true)).toBe(true);
    expect(shouldRestoreCheckpoint(["/other.sqlite3"], "/nooklet.sqlite3", true)).toBe(true);
  });

  it("never restores over an existing replica, even with a checkpoint available", () => {
    expect(shouldRestoreCheckpoint(["/nooklet.sqlite3"], "/nooklet.sqlite3", true)).toBe(false);
  });

  it("does nothing without a checkpoint, regardless of pool state", () => {
    expect(shouldRestoreCheckpoint([], "/nooklet.sqlite3", false)).toBe(false);
    expect(shouldRestoreCheckpoint(["/nooklet.sqlite3"], "/nooklet.sqlite3", false)).toBe(false);
  });
});
