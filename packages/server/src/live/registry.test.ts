import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import {
  findWindowById,
  listWindows,
  mostRecentlyActive,
  registerWindow,
  unregisterWindow,
} from "./registry.js";
import { fakeWindowConnection } from "./test-helpers.js";

// Named `ctx()` for readability at call sites below; returns a `SqlDriver` (the registry's actual
// key, `./registry.ts`'s header comment explains why) — a fresh in-memory one per call, so two
// calls in the same test are two independent "servers," never cross-talking.
function ctx() {
  return openDb({ path: ":memory:" });
}

describe("live window registry (ADR 015 §1-2)", () => {
  it("starts empty", () => {
    expect(listWindows(ctx())).toEqual([]);
  });

  it("registers a window from its hello", () => {
    const c = ctx();
    const { ws } = fakeWindowConnection();
    registerWindow(c, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    const all = listWindows(c);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: false,
      focused: false,
      page: null,
    });
  });

  it("a second hello on the SAME socket updates the entry in place, not a duplicate", () => {
    const c = ctx();
    const { ws } = fakeWindowConnection();
    registerWindow(c, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    registerWindow(c, ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: true,
      page: { id: "p1", name: "Projects/Aurora" },
      focused: true,
    });
    const all = listWindows(c);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      controlEnabled: true,
      focused: true,
      page: { id: "p1", name: "Projects/Aurora" },
    });
  });

  it("keeps connectedAt across a re-hello but bumps lastActiveAt", () => {
    const c = ctx();
    const { ws } = fakeWindowConnection();
    registerWindow(c, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    const first = listWindows(c)[0];
    registerWindow(c, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    const second = listWindows(c)[0];
    expect(second?.connectedAt).toBe(first?.connectedAt);
    expect(second?.lastActiveAt).toBeGreaterThanOrEqual(first?.lastActiveAt ?? 0);
  });

  it("unregisters a window on close", () => {
    const c = ctx();
    const { ws } = fakeWindowConnection();
    registerWindow(c, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    unregisterWindow(c, ws);
    expect(listWindows(c)).toEqual([]);
  });

  it("unregistering a never-registered socket is a harmless no-op", () => {
    const c = ctx();
    const { ws } = fakeWindowConnection();
    expect(() => unregisterWindow(c, ws)).not.toThrow();
  });

  it("findWindowById looks up by window_id alone, across devices", () => {
    const c = ctx();
    const a = fakeWindowConnection();
    const b = fakeWindowConnection();
    registerWindow(c, a.ws, { deviceId: "dev-a", windowId: "win-a", controlEnabled: false });
    registerWindow(c, b.ws, { deviceId: "dev-b", windowId: "win-b", controlEnabled: false });
    expect(findWindowById(c, "win-b")?.deviceId).toBe("dev-b");
    expect(findWindowById(c, "no-such-window")).toBeUndefined();
  });

  it("mostRecentlyActive picks the window whose hello landed last, even within the same millisecond", () => {
    const c = ctx();
    const a = fakeWindowConnection();
    const b = fakeWindowConnection();
    registerWindow(c, a.ws, { deviceId: "dev-a", windowId: "win-a", controlEnabled: false });
    registerWindow(c, b.ws, { deviceId: "dev-b", windowId: "win-b", controlEnabled: false });
    expect(mostRecentlyActive(c)?.windowId).toBe("win-b");
  });

  it("a re-hello (keeping it updated) moves a window back to most-recently-active", () => {
    const c = ctx();
    const a = fakeWindowConnection();
    const b = fakeWindowConnection();
    registerWindow(c, a.ws, { deviceId: "dev-a", windowId: "win-a", controlEnabled: false });
    registerWindow(c, b.ws, { deviceId: "dev-b", windowId: "win-b", controlEnabled: false });
    expect(mostRecentlyActive(c)?.windowId).toBe("win-b");
    registerWindow(c, a.ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: false,
      focused: true,
    });
    expect(mostRecentlyActive(c)?.windowId).toBe("win-a");
  });

  it("mostRecentlyActive is undefined when nothing is live", () => {
    expect(mostRecentlyActive(ctx())).toBeUndefined();
  });

  it("two separate ServerContexts never cross-talk (WeakMap-per-context, ../sync/realtime.ts's pattern)", () => {
    const c1 = ctx();
    const c2 = ctx();
    const { ws } = fakeWindowConnection();
    registerWindow(c1, ws, { deviceId: "dev-a", windowId: "win-1", controlEnabled: false });
    expect(listWindows(c1)).toHaveLength(1);
    expect(listWindows(c2)).toHaveLength(0);
  });
});
