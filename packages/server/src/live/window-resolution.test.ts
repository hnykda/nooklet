import type { SqlDriver } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { registerWindow } from "./registry.js";
import { fakeWindowConnection } from "./test-helpers.js";
import { resolveForRead, resolveForWrite } from "./window-resolution.js";

function ctx(): SqlDriver {
  return openDb({ path: ":memory:" });
}

function registerTwo(c: SqlDriver): { first: string; second: string } {
  registerWindow(c, fakeWindowConnection().ws, {
    deviceId: "dev-a",
    windowId: "win-a",
    controlEnabled: false,
  });
  registerWindow(c, fakeWindowConnection().ws, {
    deviceId: "dev-b",
    windowId: "win-b",
    controlEnabled: false,
  });
  return { first: "win-a", second: "win-b" };
}

describe("resolveForRead (ui_windows/ui_state's policy, ADR 015 §2)", () => {
  it("0 live windows: 'none', a normal non-error state", () => {
    expect(resolveForRead(ctx())).toEqual({ kind: "none" });
  });

  it("1 live window, no window_id: resolved_by only_window, no others", () => {
    const c = ctx();
    registerWindow(c, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: false,
    });
    const r = resolveForRead(c);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error("unreachable");
    expect(r.window.windowId).toBe("win-a");
    expect(r.resolvedBy).toBe("only_window");
    expect(r.others).toEqual([]);
  });

  it(">1 live windows, no window_id: defaults to most-recently-active, discloses the rest", async () => {
    const c = ctx();
    const { second } = registerTwo(c);
    const r = resolveForRead(c);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error("unreachable");
    expect(r.window.windowId).toBe(second); // the one registered (thus "active") last
    expect(r.resolvedBy).toBe("most_recently_active");
    expect(r.others).toHaveLength(1);
    expect(r.others[0]?.windowId).toBe("win-a");
  });

  it("explicit window_id, found: resolved_by requested, regardless of how many windows are live", async () => {
    const c = ctx();
    registerTwo(c);
    const r = resolveForRead(c, "win-a");
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error("unreachable");
    expect(r.resolvedBy).toBe("requested");
    expect(r.others).toEqual([]);
  });

  it("explicit window_id, not connected: not_found", () => {
    expect(resolveForRead(ctx(), "ghost")).toEqual({ kind: "not_found" });
  });
});

describe("resolveForWrite (ui_run/ui_navigate/ui_highlight's stricter policy, ADR 015 §2)", () => {
  it("0 live windows: 'none'", () => {
    expect(resolveForWrite(ctx())).toEqual({ kind: "none" });
  });

  it("1 live window, no window_id: used automatically", () => {
    const c = ctx();
    registerWindow(c, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: false,
    });
    const r = resolveForWrite(c);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error("unreachable");
    expect(r.window.windowId).toBe("win-a");
  });

  it(">1 live windows, no window_id: refuses to guess — 'ambiguous', lists every candidate", async () => {
    const c = ctx();
    registerTwo(c);
    const r = resolveForWrite(c);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.windows.map((w) => w.windowId).sort()).toEqual(["win-a", "win-b"]);
  });

  it("explicit window_id, found: resolved even with several windows live", async () => {
    const c = ctx();
    registerTwo(c);
    const r = resolveForWrite(c, "win-a");
    expect(r).toEqual({ kind: "resolved", window: expect.objectContaining({ windowId: "win-a" }) });
  });

  it("explicit window_id, not connected: not_found", () => {
    expect(resolveForWrite(ctx(), "ghost")).toEqual({ kind: "not_found" });
  });
});
