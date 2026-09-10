import { describe, expect, it } from "vitest";
import { type ConsentStorageAdapter, createConsentStore } from "./consent.js";

function fakeStorage(): ConsentStorageAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}

describe("createConsentStore (ADR 015 §2.6)", () => {
  it("defaults: view ON, control OFF — the asymmetric default the whole feature is built on", () => {
    const store = createConsentStore(fakeStorage());
    expect(store.get()).toEqual({ viewEnabled: true, controlEnabled: false });
  });

  it("persists a toggle and reflects it immediately from get()", () => {
    const storage = fakeStorage();
    const store = createConsentStore(storage);
    store.setControlEnabled(true);
    expect(store.get().controlEnabled).toBe(true);
    expect(storage.values.get("nooklet.live.controlEnabled")).toBe("true");
  });

  it("a fresh store over the SAME storage picks up a previously-persisted toggle", () => {
    const storage = fakeStorage();
    createConsentStore(storage).setViewEnabled(false);
    const second = createConsentStore(storage);
    expect(second.get().viewEnabled).toBe(false);
  });

  it("toggles are independent — flipping one never touches the other", () => {
    const store = createConsentStore(fakeStorage());
    store.setControlEnabled(true);
    expect(store.get()).toEqual({ viewEnabled: true, controlEnabled: true });
    store.setViewEnabled(false);
    expect(store.get()).toEqual({ viewEnabled: false, controlEnabled: true });
  });

  it("subscribe() notifies listeners on every change and unsubscribes cleanly", () => {
    const store = createConsentStore(fakeStorage());
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.controlEnabled));
    store.setControlEnabled(true);
    store.setControlEnabled(false);
    unsubscribe();
    store.setControlEnabled(true);
    expect(seen).toEqual([true, false]);
  });

  it("works (in-memory) with no adapter, and never throws on a throwing adapter", () => {
    expect(() => createConsentStore().setViewEnabled(false)).not.toThrow();
    const throwing: ConsentStorageAdapter = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    };
    const store = createConsentStore(throwing);
    expect(store.get()).toEqual({ viewEnabled: true, controlEnabled: false });
    expect(() => store.setControlEnabled(true)).not.toThrow();
    expect(store.get().controlEnabled).toBe(true);
  });
});
