import { describe, expect, it } from "vitest";
import type { EditorContextSnapshot } from "../app/editor-host.js";
import { DEFAULT_WHEN_CONTEXT } from "../commands/types.js";
import { buildUiWindowState } from "./state-snapshot.js";

function editorSnapshot(overrides: Partial<EditorContextSnapshot> = {}): EditorContextSnapshot {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    ...overrides,
  };
}

const PANELS = { sidebarOpen: true, activeView: "page", dialogOpen: null };

describe("buildUiWindowState (ADR 015 §2.3)", () => {
  it("mode 'none' when neither editing nor block-selecting", () => {
    const state = buildUiWindowState({
      windowId: "w1",
      deviceId: "d1",
      focused: true,
      editor: editorSnapshot(),
      cursor: null,
      page: null,
      zoomRootBlockId: null,
      panels: PANELS,
      now: () => "2026-09-11T00:00:00.000Z",
    });
    expect(state.focus).toEqual({
      mode: "none",
      block_id: null,
      selected_block_ids: [],
      cursor: null,
    });
  });

  it("mode 'editing': block_id and cursor come from focusedBlockId/cursor; selected_block_ids is empty", () => {
    const state = buildUiWindowState({
      windowId: "w1",
      deviceId: "d1",
      focused: true,
      editor: editorSnapshot({
        editorFocused: true,
        focusedBlockId: "b1",
        selectedBlockIds: ["b1"],
      }),
      cursor: { anchor: 3, head: 7 },
      page: { id: "p1", name: "Projects/Aurora", kind: "page" },
      zoomRootBlockId: null,
      panels: PANELS,
      now: () => "2026-09-11T00:00:00.000Z",
    });
    expect(state.focus).toEqual({
      mode: "editing",
      block_id: "b1",
      selected_block_ids: [],
      cursor: { anchor: 3, head: 7 },
    });
    expect(state.page).toEqual({ id: "p1", name: "Projects/Aurora", kind: "page" });
  });

  it("mode 'block_selection': block_id is the first selected id (anchor); cursor is null even if given", () => {
    const state = buildUiWindowState({
      windowId: "w1",
      deviceId: "d1",
      focused: true,
      editor: editorSnapshot({ blockSelected: true, selectedBlockIds: ["b2", "b3"] }),
      cursor: { anchor: 1, head: 1 }, // must be ignored outside editing mode
      page: null,
      zoomRootBlockId: "b2",
      panels: PANELS,
      now: () => "2026-09-11T00:00:00.000Z",
    });
    expect(state.focus).toEqual({
      mode: "block_selection",
      block_id: "b2",
      selected_block_ids: ["b2", "b3"],
      cursor: null,
    });
    expect(state.zoom_root_block_id).toBe("b2");
  });

  it("carries window/device identity, viewport defaults, panels, and updated_at through verbatim", () => {
    const state = buildUiWindowState({
      windowId: "9f2k3xzr7htv1",
      deviceId: "1k7f3q9pv2hzk8",
      focused: false,
      editor: editorSnapshot(),
      cursor: null,
      page: null,
      zoomRootBlockId: null,
      panels: { sidebarOpen: false, activeView: "search", dialogOpen: "command-palette" },
      now: () => "2026-09-11T08:14:02.000Z",
    });
    expect(state.window_id).toBe("9f2k3xzr7htv1");
    expect(state.device_id).toBe("1k7f3q9pv2hzk8");
    expect(state.focused).toBe(false);
    expect(state.viewport).toEqual({
      first_visible_block_id: null,
      last_visible_block_id: null,
      scroll_top: 0,
    });
    expect(state.panels).toEqual({
      sidebar_open: false,
      active_view: "search",
      dialog_open: "command-palette",
    });
    expect(state.updated_at).toBe("2026-09-11T08:14:02.000Z");
  });

  it("passes through an explicit viewport when given", () => {
    const state = buildUiWindowState({
      windowId: "w1",
      deviceId: "d1",
      focused: true,
      editor: editorSnapshot(),
      cursor: null,
      page: null,
      zoomRootBlockId: null,
      panels: PANELS,
      viewport: { firstVisibleBlockId: "b1", lastVisibleBlockId: "b9", scrollTop: 240 },
    });
    expect(state.viewport).toEqual({
      first_visible_block_id: "b1",
      last_visible_block_id: "b9",
      scroll_top: 240,
    });
  });
});
