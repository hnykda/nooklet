import { describe, expect, it } from "vitest";
import { createMruStore, type MruStorageAdapter } from "./mru.js";

function fakeStorage(): MruStorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("createMruStore", () => {
  it("starts empty", () => {
    const mru = createMruStore();
    expect(mru.list()).toEqual([]);
    expect(mru.indexOf("command", "app.openSettings")).toBe(Number.POSITIVE_INFINITY);
  });

  it("records and reports position, most-recent-first", () => {
    const mru = createMruStore();
    mru.record("command", "app.toggleSidebar", 1);
    mru.record("command", "app.openSettings", 2);
    expect(mru.indexOf("command", "app.openSettings")).toBe(0);
    expect(mru.indexOf("command", "app.toggleSidebar")).toBe(1);
  });

  it("re-recording an existing id moves it to the front instead of duplicating", () => {
    const mru = createMruStore();
    mru.record("command", "a", 1);
    mru.record("command", "b", 2);
    mru.record("command", "a", 3);
    expect(mru.list().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("keeps 'command' and 'page' kinds independent for the same id string", () => {
    const mru = createMruStore();
    mru.record("page", "shared-id", 1);
    expect(mru.indexOf("command", "shared-id")).toBe(Number.POSITIVE_INFINITY);
    expect(mru.indexOf("page", "shared-id")).toBe(0);
  });

  it("caps the list at 20 entries", () => {
    const mru = createMruStore();
    for (let i = 0; i < 25; i++) mru.record("command", `cmd.${i}`, i);
    expect(mru.list()).toHaveLength(20);
    // Most recent 20 survive; the oldest 5 are evicted.
    expect(mru.list().map((e) => e.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `cmd.${24 - i}`),
    );
  });

  it("persists across store instances sharing the same adapter", () => {
    const storage = fakeStorage();
    createMruStore(storage).record("command", "app.openSettings", 1);
    expect(createMruStore(storage).indexOf("command", "app.openSettings")).toBe(0);
  });

  it("never throws on corrupted storage content", () => {
    const storage: MruStorageAdapter = { getItem: () => "not json{{{", setItem: () => {} };
    const mru = createMruStore(storage);
    expect(() => mru.list()).not.toThrow();
    expect(mru.list()).toEqual([]);
  });

  it("never throws when the adapter itself throws", () => {
    const storage: MruStorageAdapter = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    const mru = createMruStore(storage);
    expect(() => mru.record("command", "x", 1)).not.toThrow();
    expect(() => mru.list()).not.toThrow();
  });
});
