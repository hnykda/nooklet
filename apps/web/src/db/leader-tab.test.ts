import { describe, expect, it } from "vitest";
import { leaderLockWaitMs, markLeaderTab, SAME_TAB_LOCK_WAIT_MS } from "./leader-tab.js";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("leader-tab (a reload waits for its own previous page load's lock)", () => {
  it("a tab that never led this replica does not wait: a second tab follows at once (B-81)", () => {
    expect(leaderLockWaitMs("g1", memoryStorage())).toBe(0);
  });

  it("a tab that led this replica waits on its next page load", () => {
    const store = memoryStorage();
    markLeaderTab("g1", store);
    expect(leaderLockWaitMs("g1", store)).toBe(SAME_TAB_LOCK_WAIT_MS);
  });

  it("is per replica: leading one graph does not make another wait", () => {
    const store = memoryStorage();
    markLeaderTab("g1", store);
    expect(leaderLockWaitMs("g2", store)).toBe(0);
  });

  it("storage that throws or is missing means no wait, never an error", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() => markLeaderTab("g1", throwing)).not.toThrow();
    expect(leaderLockWaitMs("g1", throwing)).toBe(0);
    expect(leaderLockWaitMs("g1", undefined)).toBe(0);
  });
});
