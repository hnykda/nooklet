import { describe, expect, it } from "vitest";
import { getOrCreateWindowId } from "./window-id.js";

function fakeStorage(): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}

describe("getOrCreateWindowId (ADR 015 §2.2)", () => {
  it("mints and persists a fresh id on first call", () => {
    const storage = fakeStorage();
    const id = getOrCreateWindowId(storage);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(storage.getItem("nooklet.live.windowId")).toBe(id);
  });

  it("returns the SAME id across calls with the same storage (survives a reload)", () => {
    const storage = fakeStorage();
    const first = getOrCreateWindowId(storage);
    const second = getOrCreateWindowId(storage);
    expect(second).toBe(first);
  });

  it("a fresh storage (a new tab) gets a DIFFERENT id", () => {
    const a = getOrCreateWindowId(fakeStorage());
    const b = getOrCreateWindowId(fakeStorage());
    expect(a).not.toBe(b);
  });

  it("never throws with no adapter, and still returns a usable id", () => {
    expect(() => getOrCreateWindowId()).not.toThrow();
    expect(typeof getOrCreateWindowId()).toBe("string");
  });

  it("degrades to a fresh id (never throws) when storage.getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {},
    };
    expect(() => getOrCreateWindowId(storage)).not.toThrow();
  });
});
