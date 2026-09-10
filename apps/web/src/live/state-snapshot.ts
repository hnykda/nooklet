/**
 * Builds the wire `UiWindowState` (ADR 015 §2.3) a `state.get` request answers with. Deliberately
 * a thin reshaping of state the app already tracks, not a second "what is the user doing" model:
 * `focus`/`zoom_root_block_id` come straight from `../app/editor-host.ts#activeContextSnapshot()`
 * (the same snapshot the command dispatcher builds before every keydown) plus the focused editor's
 * own cursor offsets, per the task's own instruction not to build a second copy of this.
 *
 * A pure function of its inputs — the impure "read the live app" half (route, DOM focus, editor
 * cursor) lives in `./socket.ts`'s wiring, not here, so this stays testable with plain fakes.
 */

import type { EditorContextSnapshot } from "../app/editor-host.js";

export interface UiWindowStateWire {
  window_id: string;
  device_id: string;
  focused: boolean;
  page: { id: string; name: string; kind: "page" | "journal" } | null;
  zoom_root_block_id: string | null;
  focus: {
    mode: "editing" | "block_selection" | "none";
    block_id: string | null;
    selected_block_ids: string[];
    cursor: { anchor: number; head: number } | null;
  };
  viewport: {
    first_visible_block_id: string | null;
    last_visible_block_id: string | null;
    scroll_top: number;
  };
  panels: { sidebar_open: boolean; active_view: string; dialog_open: string | null };
  updated_at: string;
}

export interface PanelState {
  sidebarOpen: boolean;
  /** e.g. "page", "journals", "search", "tasks". */
  activeView: string;
  dialogOpen: string | null;
}

export interface ViewportState {
  firstVisibleBlockId: string | null;
  lastVisibleBlockId: string | null;
  scrollTop: number;
}

export interface BuildUiWindowStateInputs {
  windowId: string;
  deviceId: string;
  /** This window is the frontmost one, if the platform can tell (e.g. `document.hasFocus()`). */
  focused: boolean;
  editor: EditorContextSnapshot;
  /** The focused block's cursor offsets (`EditorHost.getSelection()`'s `start`/`end`), or `null`
   * when nothing is focused. Ignored unless `editor.editorFocused`. */
  cursor: { anchor: number; head: number } | null;
  page: { id: string; name: string; kind: "page" | "journal" } | null;
  /** The current route's zoom root (nooklet's `?block=` query param — `../routes/PageRoute.tsx`),
   * or `null` when not zoomed. */
  zoomRootBlockId: string | null;
  panels: PanelState;
  viewport?: ViewportState;
  /** Injectable clock, for deterministic tests. */
  now?: () => string;
}

const NO_VIEWPORT: ViewportState = {
  firstVisibleBlockId: null,
  lastVisibleBlockId: null,
  scrollTop: 0,
};

export function buildUiWindowState(inputs: BuildUiWindowStateInputs): UiWindowStateWire {
  const { editor } = inputs;
  const mode: "editing" | "block_selection" | "none" = editor.editorFocused
    ? "editing"
    : editor.blockSelected
      ? "block_selection"
      : "none";
  const viewport = inputs.viewport ?? NO_VIEWPORT;
  const now = inputs.now ?? (() => new Date().toISOString());

  return {
    window_id: inputs.windowId,
    device_id: inputs.deviceId,
    focused: inputs.focused,
    page: inputs.page,
    zoom_root_block_id: inputs.zoomRootBlockId,
    focus: {
      mode,
      block_id:
        mode === "editing"
          ? editor.focusedBlockId
          : mode === "block_selection"
            ? (editor.selectedBlockIds[0] ?? null)
            : null,
      selected_block_ids: mode === "block_selection" ? editor.selectedBlockIds : [],
      cursor: mode === "editing" ? inputs.cursor : null,
    },
    viewport: {
      first_visible_block_id: viewport.firstVisibleBlockId,
      last_visible_block_id: viewport.lastVisibleBlockId,
      scroll_top: viewport.scrollTop,
    },
    panels: {
      sidebar_open: inputs.panels.sidebarOpen,
      active_view: inputs.panels.activeView,
      dialog_open: inputs.panels.dialogOpen,
    },
    updated_at: now(),
  };
}
