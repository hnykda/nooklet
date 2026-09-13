import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeAppHost, createFakeNavigationHost } from "../hosts/nav-host.js";
import { createFakeStore } from "../hosts/store.js";
import { createPaletteController } from "../palette/palette-controller.js";
import { createCommandRegistry } from "../registry.js";
import { createFakeDatePickerHost } from "./date-picker-host.js";
import { createCoreCommands } from "./index.js";

function makeDeps() {
  return {
    editor: createFakeEditorHost(),
    navigation: createFakeNavigationHost(),
    app: createFakeAppHost(),
    palette: createPaletteController(),
    datePicker: createFakeDatePickerHost(),
  };
}

describe("createCoreCommands", () => {
  it("produces a large, fully-populated core command set with no duplicate ids", () => {
    const commands = createCoreCommands(makeDeps());
    expect(commands.length).toBeGreaterThan(70);
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command registers without error (valid id shape + valid `when`)", () => {
    const registry = createCommandRegistry();
    const commands = createCoreCommands(makeDeps());
    for (const c of commands) {
      expect(() => registry.register(c)).not.toThrow();
    }
    expect(registry.list()).toHaveLength(commands.length);
  });

  it("covers every core area named in R2", () => {
    const commands = createCoreCommands(makeDeps());
    const areas = new Set(commands.map((c) => c.id.split(".")[0]));
    for (const area of ["block", "task", "nav", "search", "format", "edit", "app", "sync"]) {
      expect(areas).toContain(area);
    }
  });
});

describe("createCoreCommands — spot-check real behavior end-to-end", () => {
  it("task.cycle advances null -> TODO via the fake store", async () => {
    const store = createFakeStore({ b1: {} });
    const deps = { ...makeDeps() };
    const commands = createCoreCommands(deps);
    const cycle = commands.find((c) => c.id === "task.cycle");
    expect(cycle).toBeDefined();
    await cycle?.run({
      editorFocused: true,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac",
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store,
      exec: async () => {},
    });
    expect(store.props.get("b1")?.marker).toBe("TODO");
  });

  it("format.bold wraps the current selection via the fake editor host", () => {
    const deps = makeDeps();
    deps.editor.state = { blockId: "b1", content: "hello", start: 0, end: 5 };
    const commands = createCoreCommands(deps);
    const bold = commands.find((c) => c.id === "format.bold");
    bold?.run({
      editorFocused: true,
      blockSelected: false,
      hasSelection: true,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac",
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    });
    expect(deps.editor.state?.content).toBe("**hello**");
  });

  it("a structural command (block.indent) delegates to the editor host untouched", () => {
    const deps = makeDeps();
    const commands = createCoreCommands(deps);
    const indent = commands.find((c) => c.id === "block.indent");
    const ctx = {
      editorFocused: true,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac" as const,
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    };
    indent?.run(ctx);
    expect(deps.editor.structuralCalls).toEqual([{ id: "block.indent", ctx }]);
  });

  it("palette.open toggles the palette controller open, then closed", () => {
    const deps = makeDeps();
    const commands = createCoreCommands(deps);
    const open = commands.find((c) => c.id === "palette.open");
    const ctx = {
      editorFocused: false,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac" as const,
      mobile: false,
      focusedBlockId: null,
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    };
    open?.run(ctx);
    expect(deps.palette.isOpen()).toBe(true);
    open?.run(ctx);
    expect(deps.palette.isOpen()).toBe(false);
  });
});
