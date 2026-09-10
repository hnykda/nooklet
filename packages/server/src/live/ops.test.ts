/**
 * End-to-end tests for the five `ui.*` ops (ADR 015 §2.5), through the real HTTP mount
 * (`../http/app.ts`) and the real `OpRegistry`, against fake `/ui/live` window connections
 * (`./test-helpers.ts`) — no real WebSocket/browser needed, per the task's own instruction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken } from "../auth/tokens.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import { registerWindow } from "./registry.js";
import { autoRespondingWindow, fakeWindowConnection } from "./test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

function uiControlToken(scope: "read" | "write" | "admin" = "read"): string {
  return createToken(s.serverCtx.driver, { label: "agent", scope, uiControl: true }).token;
}

describe("ui_windows", () => {
  it("returns live: false and an empty list when nobody has nooklet open", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.windows", uiControlToken(), {});
    expect(status).toBe(200);
    expect(json).toEqual({ live: false, windows: [] });
  });

  it("lists a registered window with its fields", async () => {
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      client: "nooklet-web/0.1",
      controlEnabled: true,
      page: { id: "p1", name: "Projects/Aurora" },
      focused: true,
    });
    const { status, json } = await post(s.app, "/api/v1/ui.windows", uiControlToken(), {});
    expect(status).toBe(200);
    expect(json.live).toBe(true);
    expect(json.windows).toHaveLength(1);
    expect(json.windows[0]).toMatchObject({
      window_id: "win-1",
      device_id: "dev-a",
      control_enabled: true,
      focused: true,
      page: { id: "p1", name: "Projects/Aurora" },
    });
  });

  it("403s a token without the ui:control capability, even with write+admin scope", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.windows", s.adminToken, {});
    expect(status).toBe(403);
    expect(json.error.code).toBe("forbidden");
  });

  it("403s a plain write-scoped token (rule 10's per-op scope check, not just tools/list)", async () => {
    const { status } = await post(s.app, "/api/v1/ui.windows", s.writeToken, {});
    expect(status).toBe(403);
  });
});

describe("ui_state", () => {
  it("live: false, no error, when no window is open anywhere", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.state", uiControlToken(), {});
    expect(status).toBe(200);
    expect(json).toEqual({ live: false });
  });

  it("not_found for an explicit window_id that isn't connected", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.state", uiControlToken(), {
      window_id: "ghost",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("returns the window's reported state, resolved_by only_window when exactly one is live", async () => {
    const stateWire = {
      window_id: "win-1",
      device_id: "dev-a",
      focused: true,
      page: { id: "p1", name: "Projects/Aurora", kind: "page" },
      zoom_root_block_id: null,
      focus: { mode: "none", block_id: null, selected_block_ids: [], cursor: null },
      viewport: { first_visible_block_id: null, last_visible_block_id: null, scroll_top: 0 },
      panels: { sidebar_open: true, active_view: "page", dialog_open: null },
      updated_at: new Date().toISOString(),
    };
    const conn = autoRespondingWindow(s.serverCtx.driver, () => ({
      type: "state.result",
      state: stateWire,
    }));
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: false,
    });

    const { status, json } = await post(s.app, "/api/v1/ui.state", uiControlToken(), {});
    expect(status).toBe(200);
    expect(json.live).toBe(true);
    expect(json.window_id).toBe("win-1");
    expect(json.resolved_by).toBe("only_window");
    expect(json.reachable).toBe(true);
    expect(json.state).toEqual(stateWire);
    expect(conn.sent[0]?.type).toBe("state.get");
  });

  it("with >1 live windows and no window_id, resolves to most-recently-active and discloses other_windows", async () => {
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: false,
      page: { id: "pa", name: "Page A" },
    });
    const conn = autoRespondingWindow(s.serverCtx.driver, () => ({
      state: { window_id: "win-b" },
    }));
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-b",
      windowId: "win-b",
      controlEnabled: false,
      page: { id: "pb", name: "Page B" },
    });

    const { json } = await post(s.app, "/api/v1/ui.state", uiControlToken(), {});
    expect(json.resolved_by).toBe("most_recently_active");
    expect(json.window_id).toBe("win-b");
    expect(json.other_windows).toEqual([{ window_id: "win-a", page: "Page A" }]);
  });

  it("degrades gracefully to reachable: false when the window does not answer in time (never an error)", async () => {
    vi.useFakeTimers();
    try {
      registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
        deviceId: "dev-a",
        windowId: "win-1",
        controlEnabled: false,
      });
      const pending = post(s.app, "/api/v1/ui.state", uiControlToken(), {});
      await vi.advanceTimersByTimeAsync(2100);
      const { status, json } = await pending;
      expect(status).toBe(200);
      expect(json).toMatchObject({ live: true, window_id: "win-1", reachable: false });
      expect(json.state).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ui_run", () => {
  it("no_live_window (not_found) when nothing is open and window_id is omitted", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken("write"), {
      command_id: "nav.openPage",
      args: { page: "Projects/Aurora" },
    });
    expect(status).toBe(404);
    expect(json.error.details?.reason).toBe("no_live_window");
  });

  it("ambiguous_window (conflict) with >1 windows and no window_id — refuses to guess", async () => {
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: true,
    });
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-b",
      windowId: "win-b",
      controlEnabled: true,
    });
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken("write"), {
      command_id: "nav.openPage",
      args: {},
    });
    expect(status).toBe(409);
    expect(json.error.details?.reason).toBe("ambiguous_window");
    expect(
      json.error.details?.windows.map((w: { window_id: string }) => w.window_id).sort(),
    ).toEqual(["win-a", "win-b"]);
  });

  it("forbidden, hinting at the toggle, when the target window has not enabled control", async () => {
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: false,
    });
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken("write"), {
      command_id: "nav.openPage",
      args: {},
      window_id: "win-1",
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe("forbidden");
    expect(json.error.hint).toMatch(/let agents control this window/i);
  });

  it("runs the command against the window and relays when_result/result/changed", async () => {
    const conn = autoRespondingWindow(s.serverCtx.driver, (frame) => {
      expect(frame.command_id).toBe("task.setMarkerDone");
      expect(frame.args).toEqual({ blockId: "1k7f3q9xz2hav4" });
      expect(frame.actor).toBe("agent-ui");
      return {
        when_result: "ran",
        result: { ok: true },
        changed: { created: [], updated: ["1k7f3q9xz2hav4"], deleted: [], seq: 5 },
      };
    });
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: true,
    });

    const token = createToken(s.serverCtx.driver, {
      label: "agent-ui",
      scope: "read",
      uiControl: true,
    }).token;
    const { status, json } = await post(s.app, "/api/v1/ui.run", token, {
      command_id: "task.setMarkerDone",
      args: { blockId: "1k7f3q9xz2hav4" },
      window_id: "win-1",
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      window_id: "win-1",
      when_result: "ran",
      result: { ok: true },
      changed: { created: [], updated: ["1k7f3q9xz2hav4"], deleted: [], seq: 5 },
    });
  });

  it("a read+ui:control token (no write scope) can still call ui_run — server defers per-command scope to the client", async () => {
    const conn = autoRespondingWindow(s.serverCtx.driver, () => ({
      when_result: "skipped_when_false",
    }));
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: true,
    });
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken("read"), {
      command_id: "block.zoomIn",
      window_id: "win-1",
    });
    expect(status).toBe(200);
    expect(json.when_result).toBe("skipped_when_false");
  });

  it("403s without ui:control, even for an admin token", async () => {
    const { status, json } = await post(s.app, "/api/v1/ui.run", s.adminToken, {
      command_id: "nav.openPage",
      args: {},
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe("forbidden");
  });
});

describe("ui_navigate / ui_highlight (thin ui_run wrappers)", () => {
  it("ui_navigate sends nav.openPage and echoes the page back", async () => {
    const conn = autoRespondingWindow(s.serverCtx.driver, (frame) => {
      expect(frame.command_id).toBe("nav.openPage");
      expect(frame.args).toEqual({ page: "Projects/Aurora", blockId: "1k7f3q9xz2hav4" });
      return { when_result: "ran" };
    });
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: true,
    });

    const { status, json } = await post(s.app, "/api/v1/ui.navigate", uiControlToken(), {
      page: "Projects/Aurora",
      block_id: "1k7f3q9xz2hav4",
      window_id: "win-1",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ window_id: "win-1", page: "Projects/Aurora" });
  });

  it("ui_highlight sends nav.revealBlock", async () => {
    const conn = autoRespondingWindow(s.serverCtx.driver, (frame) => {
      expect(frame.command_id).toBe("nav.revealBlock");
      expect(frame.args).toEqual({ blockId: "1k7f3q9xz2hav4" });
      return { when_result: "ran" };
    });
    registerWindow(s.serverCtx.driver, conn.ws, {
      deviceId: "dev-a",
      windowId: "win-1",
      controlEnabled: true,
    });

    const { status, json } = await post(s.app, "/api/v1/ui.highlight", uiControlToken(), {
      block_id: "1k7f3q9xz2hav4",
      window_id: "win-1",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ window_id: "win-1" });
  });

  it("both share ui_run's ambiguous_window error", async () => {
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-a",
      windowId: "win-a",
      controlEnabled: true,
    });
    registerWindow(s.serverCtx.driver, fakeWindowConnection().ws, {
      deviceId: "dev-b",
      windowId: "win-b",
      controlEnabled: true,
    });
    const { status, json } = await post(s.app, "/api/v1/ui.highlight", uiControlToken(), {
      block_id: "1k7f3q9xz2hav4",
    });
    expect(status).toBe(409);
    expect(json.error.details?.reason).toBe("ambiguous_window");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
