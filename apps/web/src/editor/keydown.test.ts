import { describe, expect, it } from "vitest";
import { type DispatchCtx, type KeyDescriptor, resolveCommand } from "./keydown.js";

const base: DispatchCtx = {
  editorFocused: false,
  blockSelected: false,
  hasSelection: false,
  selectionCount: 0,
  atLineStart: false,
  atLineEnd: false,
  onFirstVisualLine: false,
  onLastVisualLine: false,
  hasChildren: false,
  isCollapsed: false,
  zoomed: false,
  composing: false,
  popupOpen: false,
};

function key(k: string, mods: Partial<KeyDescriptor> = {}): KeyDescriptor {
  return { key: k, mod: false, shift: false, alt: false, ...mods };
}

describe("resolveCommand — R12 dispatch order", () => {
  it("composing: never handled, regardless of what the key would otherwise mean", () => {
    const ctx: DispatchCtx = { ...base, editorFocused: true, atLineStart: true, composing: true };
    expect(resolveCommand(key("Backspace"), ctx)).toBeNull();
    expect(resolveCommand(key("Enter"), ctx)).toBeNull();
  });

  it("popup open: Escape/Enter/Arrow/Tab fall through to the popup's own keymap", () => {
    const ctx: DispatchCtx = { ...base, editorFocused: true, popupOpen: true };
    expect(resolveCommand(key("Escape"), ctx)).toBeNull();
    expect(resolveCommand(key("Enter"), ctx)).toBeNull();
    expect(resolveCommand(key("ArrowUp"), ctx)).toBeNull();
    expect(resolveCommand(key("ArrowDown"), ctx)).toBeNull();
    expect(resolveCommand(key("Tab"), ctx)).toBeNull();
  });

  it("popup open: keys NOT in the popup's set still dispatch normally", () => {
    const ctx: DispatchCtx = { ...base, editorFocused: true, popupOpen: true };
    expect(resolveCommand(key("Backspace"), { ...ctx, atLineStart: true })).toBe(
      "block.mergeWithPrevious",
    );
  });
});

describe("resolveCommand — editorFocused (R16-R30)", () => {
  const ef = { ...base, editorFocused: true };

  it("Enter splits; Shift+Enter inserts a newline (no split); Mod+Enter cycles the task", () => {
    expect(resolveCommand(key("Enter"), ef)).toBe("block.split");
    expect(resolveCommand(key("Enter", { shift: true }), ef)).toBe("block.newline");
    expect(resolveCommand(key("Enter", { mod: true }), ef)).toBe("task.cycle");
  });

  it("Tab indents, Shift+Tab outdents", () => {
    expect(resolveCommand(key("Tab"), ef)).toBe("block.indent");
    expect(resolveCommand(key("Tab", { shift: true }), ef)).toBe("block.outdent");
  });

  it("Backspace merges with previous ONLY at line start with no selection", () => {
    expect(resolveCommand(key("Backspace"), { ...ef, atLineStart: true })).toBe(
      "block.mergeWithPrevious",
    );
    expect(resolveCommand(key("Backspace"), { ...ef, atLineStart: false })).toBeNull();
    expect(
      resolveCommand(key("Backspace"), { ...ef, atLineStart: true, hasSelection: true }),
    ).toBeNull();
  });

  it("Delete merges forward ONLY at line end with no selection", () => {
    expect(resolveCommand(key("Delete"), { ...ef, atLineEnd: true })).toBe(
      "block.deleteForwardMerge",
    );
    expect(resolveCommand(key("Delete"), { ...ef, atLineEnd: false })).toBeNull();
    expect(
      resolveCommand(key("Delete"), { ...ef, atLineEnd: true, hasSelection: true }),
    ).toBeNull();
  });

  it("Alt+Up/Down move the block", () => {
    expect(resolveCommand(key("ArrowUp", { alt: true }), ef)).toBe("block.moveUp");
    expect(resolveCommand(key("ArrowDown", { alt: true }), ef)).toBe("block.moveDown");
  });

  it("plain Up/Down cross blocks only at the first/last VISUAL line", () => {
    expect(resolveCommand(key("ArrowUp"), { ...ef, onFirstVisualLine: true })).toBe(
      "block.focusPreviousLine",
    );
    expect(resolveCommand(key("ArrowUp"), { ...ef, onFirstVisualLine: false })).toBeNull();
    expect(resolveCommand(key("ArrowDown"), { ...ef, onLastVisualLine: true })).toBe(
      "block.focusNextLine",
    );
    expect(resolveCommand(key("ArrowDown"), { ...ef, onLastVisualLine: false })).toBeNull();
  });

  it("plain Left/Right cross blocks only at atLineStart/atLineEnd", () => {
    expect(resolveCommand(key("ArrowLeft"), { ...ef, atLineStart: true })).toBe(
      "block.focusPreviousChar",
    );
    expect(resolveCommand(key("ArrowLeft"), { ...ef, atLineStart: false })).toBeNull();
    expect(resolveCommand(key("ArrowRight"), { ...ef, atLineEnd: true })).toBe(
      "block.focusNextChar",
    );
  });

  it("collapse/expand are gated by hasChildren and the CURRENT collapsed state", () => {
    expect(
      resolveCommand(key("ArrowUp", { mod: true }), {
        ...ef,
        hasChildren: true,
        isCollapsed: false,
      }),
    ).toBe("block.collapse");
    expect(
      resolveCommand(key("ArrowUp", { mod: true }), {
        ...ef,
        hasChildren: false,
        isCollapsed: false,
      }),
    ).toBeNull();
    expect(
      resolveCommand(key("ArrowUp", { mod: true }), {
        ...ef,
        hasChildren: true,
        isCollapsed: true,
      }),
    ).toBeNull();
    expect(
      resolveCommand(key("ArrowDown", { mod: true }), {
        ...ef,
        hasChildren: true,
        isCollapsed: true,
      }),
    ).toBe("block.expand");
  });

  it("zoom in always available; zoom out only when already zoomed", () => {
    expect(resolveCommand(key(".", { mod: true }), ef)).toBe("block.zoomIn");
    expect(
      resolveCommand(key(".", { mod: true, shift: true }), { ...ef, zoomed: false }),
    ).toBeNull();
    expect(resolveCommand(key(".", { mod: true, shift: true }), { ...ef, zoomed: true })).toBe(
      "block.zoomOut",
    );
  });

  it("Escape enters block-selection mode; Shift+Up/Down extend a selection from an editing block", () => {
    expect(resolveCommand(key("Escape"), ef)).toBe("block.selectBlock");
    expect(resolveCommand(key("ArrowUp", { shift: true }), ef)).toBe("block.extendSelectionUp");
    expect(resolveCommand(key("ArrowDown", { shift: true }), ef)).toBe("block.extendSelectionDown");
  });

  it("Mod+Shift+D duplicates; Mod+Shift+C copies a block ref", () => {
    expect(resolveCommand(key("d", { mod: true, shift: true }), ef)).toBe("block.duplicate");
    expect(resolveCommand(key("c", { mod: true, shift: true }), ef)).toBe("block.copyRef");
  });

  it("an unmapped plain character falls through (ordinary typing)", () => {
    expect(resolveCommand(key("a"), ef)).toBeNull();
  });
});

describe("resolveCommand — blockSelected (R28-R32)", () => {
  const bs = { ...base, blockSelected: true };

  it("Enter edits the selected block; Escape clears the selection", () => {
    expect(resolveCommand(key("Enter"), bs)).toBe("block.editSelected");
    expect(resolveCommand(key("Escape"), bs)).toBe("block.clearSelection");
  });

  it("Backspace AND Delete both delete the selection (R21's secondary binding)", () => {
    expect(resolveCommand(key("Backspace"), bs)).toBe("block.deleteSelected");
    expect(resolveCommand(key("Delete"), bs)).toBe("block.deleteSelected");
  });

  it("Tab/Shift+Tab indent/outdent the whole selection", () => {
    expect(resolveCommand(key("Tab"), bs)).toBe("block.indentSelected");
    expect(resolveCommand(key("Tab", { shift: true }), bs)).toBe("block.outdentSelected");
  });

  it("Mod+A selects all visible rows", () => {
    expect(resolveCommand(key("a", { mod: true }), bs)).toBe("block.selectAll");
  });

  it("Mod+Enter cycles the task ONLY when exactly one block is selected", () => {
    expect(resolveCommand(key("Enter", { mod: true }), { ...bs, selectionCount: 1 })).toBe(
      "task.cycle",
    );
    expect(resolveCommand(key("Enter", { mod: true }), { ...bs, selectionCount: 2 })).toBeNull();
  });
});

describe("resolveCommand — undo/redo are always reachable (R51: when true)", () => {
  it("Mod+Z / Mod+Shift+Z work with no surface mounted and no selection", () => {
    expect(resolveCommand(key("z", { mod: true }), base)).toBe("edit.undo");
    expect(resolveCommand(key("z", { mod: true, shift: true }), base)).toBe("edit.redo");
  });

  it("...and also while editing or while a selection is active", () => {
    expect(resolveCommand(key("z", { mod: true }), { ...base, editorFocused: true })).toBe(
      "edit.undo",
    );
    expect(resolveCommand(key("z", { mod: true }), { ...base, blockSelected: true })).toBe(
      "edit.undo",
    );
  });
});
