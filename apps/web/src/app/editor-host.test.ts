import { describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/types.js";
import {
  activeEditorHost,
  createEditorHost,
  type EditorHostBacking,
  setActiveEditorHost,
} from "./editor-host.js";

function backing(content = "hello world", anchor = 0, head = 0) {
  const state = {
    id: "blk1" as string | null,
    content,
    anchor,
    head,
    writes: [] as Array<{ id: string; text: string; caret: unknown }>,
    structural: [] as Array<{ id: string | null; commandId: string }>,
  };
  const b: EditorHostBacking = {
    currentId: () => state.id,
    content: () => state.content,
    head: () => state.head,
    anchor: () => state.anchor,
    setText: (id, text, caret) => state.writes.push({ id, text, caret }),
    runStructural: (id, commandId) => {
      state.structural.push({ id, commandId });
    },
    linkAtCaret: () => ({ type: "page", name: "Target" }),
  };
  return { state, b };
}

describe("createEditorHost", () => {
  it("reports the selection with start/end normalized regardless of drag direction", () => {
    const { b } = backing("hello world", 8, 3); // selected backwards
    const sel = createEditorHost(b).getSelection();
    expect(sel).toEqual({ blockId: "blk1", content: "hello world", start: 3, end: 8 });
  });

  it("returns null when no surface is focused", () => {
    const { state, b } = backing();
    state.id = null;
    expect(createEditorHost(b).getSelection()).toBeNull();
  });

  it("replaces a range and rebases the relative caret offset onto the new content", () => {
    const { state, b } = backing("hello world");
    // Wrap "world" in bold, keeping the caret just after the inserted "**".
    createEditorHost(b).replaceRange({ from: 6, to: 11, text: "**world**", caretOffset: 2 });
    expect(state.writes[0]?.text).toBe("hello **world**");
    // caretOffset is relative to `from`: 6 + 2, NOT 2.
    expect(state.writes[0]?.caret).toBe(8);
  });

  it("rebases a selection-shaped caret offset too", () => {
    const { state, b } = backing("hello world");
    createEditorHost(b).replaceRange({
      from: 6,
      to: 11,
      text: "**world**",
      caretOffset: { anchor: 2, head: 7 },
    });
    expect(state.writes[0]?.caret).toEqual({ anchor: 8, head: 13 });
  });

  it("defaults the caret to just after the inserted text", () => {
    const { state, b } = backing("hello world");
    createEditorHost(b).replaceRange({ from: 0, to: 5, text: "goodbye" });
    expect(state.writes[0]?.caret).toBe(7);
  });

  it("delegates structural commands with the focused block id", () => {
    const { state, b } = backing();
    createEditorHost(b).runStructuralCommand("block.indent", {} as CommandContext);
    expect(state.structural[0]).toEqual({ id: "blk1", commandId: "block.indent" });
  });
});

describe("activeEditorHost", () => {
  it("is an inert no-op host when nothing is focused", () => {
    setActiveEditorHost(null);
    const host = activeEditorHost();
    expect(host.getSelection()).toBeNull();
    expect(host.getLinkAtCaret()).toBeNull();
    // Must not throw — commands' `when` clauses gate these, this is belt and braces.
    expect(() => host.replaceRange({ from: 0, to: 0, text: "x" })).not.toThrow();
  });

  it("returns the registered host once a surface focuses, and releases it on blur", () => {
    const { b } = backing();
    const host = createEditorHost(b);
    setActiveEditorHost(host);
    expect(activeEditorHost().getSelection()?.blockId).toBe("blk1");
    setActiveEditorHost(null);
    expect(activeEditorHost().getSelection()).toBeNull();
  });
});
