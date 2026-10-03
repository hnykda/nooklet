/**
 * `shouldRestoreCheckpoint` only — the rest of this file needs real OPFS/WASM (see its own header)
 * and is exercised manually per `apps/web/README.md`'s browser-verification list.
 */
import { describe, expect, it } from "vitest";
import { shouldRestoreCheckpoint } from "./sqlite-wasm-driver.js";

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
