import { describe, expect, it } from "vitest";
import type { OpBatch } from "../commands/hosts/editor-host.js";
import type { CommandContext } from "../commands/types.js";
import { editingEndRequest } from "../editor/focus-request.js";
import {
  activeEditorHost,
  createEditorHost,
  type EditorHostBacking,
  historyEditorHost,
  liveEditorHost,
  noteUndoTarget,
  registerEditorHost,
  releaseEditorHost,
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
    batches: [] as OpBatch[],
    acceptBatches: true,
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
    commitOps: (batch) => {
      state.batches.push(batch);
      return state.acceptBatches;
    },
    linkAtCaret: () => ({ type: "page", name: "Target" }),
    currentBlock: () => null,
    zoomRoot: () => null,
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

  it("hands a command's op batch to the tree and reports whether the tree took it (B-108)", () => {
    const { state, b } = backing();
    const host = createEditorHost(b);
    const batch: OpBatch = { ops: [], anchorId: "blk1", focus: { blockId: "blk1", caret: "end" } };
    expect(host.commitOps(batch)).toBe(true);
    expect(state.batches).toEqual([batch]);
    state.acceptBatches = false;
    expect(host.commitOps(batch)).toBe(false);
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
    // No editor to commit through: the caller must apply the ops itself, so this says so.
    expect(host.commitOps({ ops: [], anchorId: "b" })).toBe(false);
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

describe("undo/redo after the editing session ends (B-241)", () => {
  it("still reach the tree whose session ended last, and nothing else does", () => {
    const { state, b } = backing();
    const host = createEditorHost(b);
    setActiveEditorHost(host);
    state.id = null; // a selection deleted, or a click away: nothing edited or selected
    setActiveEditorHost(null);

    liveEditorHost.runStructuralCommand("edit.undo", {} as CommandContext);
    liveEditorHost.runStructuralCommand("edit.redo", {} as CommandContext);
    expect(state.structural).toEqual([
      { id: null, commandId: "edit.undo" },
      { id: null, commandId: "edit.redo" },
    ]);
    // Everything else stays with the (absent) active host.
    liveEditorHost.runStructuralCommand("block.indent", {} as CommandContext);
    expect(state.structural).toHaveLength(2);
    expect(historyEditorHost()).toBe(host);
    releaseEditorHost(host);
  });

  it("a newer session takes over, and an unmounted tree is never the target", () => {
    const first = backing();
    const second = backing();
    const a = createEditorHost(first.b);
    const b = createEditorHost(second.b);
    setActiveEditorHost(a);
    setActiveEditorHost(null);
    setActiveEditorHost(b);
    setActiveEditorHost(null);
    expect(historyEditorHost()).toBe(b);

    // `a` unmounting must not clear `b`; `b` unmounting leaves nothing to undo into.
    releaseEditorHost(a);
    expect(historyEditorHost()).toBe(b);
    releaseEditorHost(b);
    liveEditorHost.runStructuralCommand("edit.undo", {} as CommandContext);
    expect(first.state.structural).toEqual([]);
    expect(second.state.structural).toEqual([]);
  });
});

describe("a command's op batch reaches a tree that shows its block, focused or not (B-142)", () => {
  const batch: OpBatch = { ops: [], anchorId: "blk1" };

  it("the active tree first; a tree that refuses is passed over for a mounted one that takes it", () => {
    const edited = backing();
    const other = backing();
    const a = createEditorHost(edited.b);
    const b = createEditorHost(other.b);
    registerEditorHost(a);
    registerEditorHost(b);
    setActiveEditorHost(a);
    expect(liveEditorHost.commitOps(batch)).toBe(true);
    expect(edited.state.batches).toHaveLength(1);
    expect(other.state.batches).toHaveLength(0);

    // The block is not in the edited tree (a chip on another journal day): the next one takes it.
    edited.state.acceptBatches = false;
    expect(liveEditorHost.commitOps(batch)).toBe(true);
    expect(other.state.batches).toHaveLength(1);
    releaseEditorHost(a);
    releaseEditorHost(b);
  });

  it("with nothing focused, the tree that took the batch becomes the undo target", () => {
    const first = backing();
    const second = backing();
    const a = createEditorHost(first.b);
    const b = createEditorHost(second.b);
    registerEditorHost(a);
    registerEditorHost(b);
    setActiveEditorHost(a);
    setActiveEditorHost(null);
    first.state.acceptBatches = false;

    expect(liveEditorHost.commitOps(batch)).toBe(true);
    expect(second.state.batches).toHaveLength(1);
    // Cmd/Ctrl+Z must reach the history the step landed in, not the tree edited last.
    expect(historyEditorHost()).toBe(b);
    releaseEditorHost(a);
    releaseEditorHost(b);
  });

  it("taken by another tree while a selection stands in the active one: that session ends (B-281)", () => {
    const selected = backing();
    const other = backing();
    const a = createEditorHost(selected.b);
    const b = createEditorHost(other.b);
    registerEditorHost(a);
    registerEditorHost(b);
    setActiveEditorHost(a);
    selected.state.acceptBatches = false;
    const ticks = editingEndRequest();

    expect(liveEditorHost.commitOps(batch)).toBe(true);
    expect(other.state.batches).toHaveLength(1);
    // Every tree drops its session on this request; the selected one then withdraws as active.
    expect(editingEndRequest()).toBe(ticks + 1);
    setActiveEditorHost(null);
    expect(historyEditorHost()).toBe(b);

    // The active tree taking it itself, or a batch that moves the caret, ends nothing.
    setActiveEditorHost(a);
    selected.state.acceptBatches = true;
    expect(liveEditorHost.commitOps(batch)).toBe(true);
    selected.state.acceptBatches = false;
    expect(liveEditorHost.commitOps({ ...batch, focus: { blockId: "blk1", caret: "end" } })).toBe(
      true,
    );
    expect(editingEndRequest()).toBe(ticks + 1);
    setActiveEditorHost(null);
    releaseEditorHost(a);
    releaseEditorHost(b);
  });

  it("no tree takes it, or none is mounted: false, so the caller writes the ops itself", () => {
    const only = backing();
    only.state.acceptBatches = false;
    const a = createEditorHost(only.b);
    registerEditorHost(a);
    expect(liveEditorHost.commitOps(batch)).toBe(false);
    releaseEditorHost(a);
    only.state.acceptBatches = true;
    // Released: an unmounted tree never takes a write.
    expect(liveEditorHost.commitOps(batch)).toBe(false);
    expect(only.state.batches).toHaveLength(1);
  });
});

describe("a write from a click on a tree's rows becomes the undo target (B-789, B-841)", () => {
  it("with nothing focused, Cmd/Ctrl+Z goes to the tree that noted the step", () => {
    const first = backing();
    const second = backing();
    const a = createEditorHost(first.b);
    const b = createEditorHost(second.b);
    registerEditorHost(a);
    registerEditorHost(b);
    // `a` was edited last; then a marker on `b`'s page is clicked with nothing there edited.
    setActiveEditorHost(a);
    setActiveEditorHost(null);
    noteUndoTarget(b);
    expect(historyEditorHost()).toBe(b);
    releaseEditorHost(a);
    releaseEditorHost(b);
  });

  it("a session standing in another tree is ended, so the undo goes where the step went", () => {
    const edited = backing();
    const clicked = backing();
    const a = createEditorHost(edited.b);
    const b = createEditorHost(clicked.b);
    setActiveEditorHost(a);
    const ticks = editingEndRequest();
    noteUndoTarget(b);
    expect(editingEndRequest()).toBe(ticks + 1);
    setActiveEditorHost(null);
    expect(historyEditorHost()).toBe(b);
    // The edited tree noting its own step ends nothing.
    setActiveEditorHost(b);
    noteUndoTarget(b);
    expect(editingEndRequest()).toBe(ticks + 1);
    setActiveEditorHost(null);
    releaseEditorHost(a);
    releaseEditorHost(b);
  });
});

describe("zoomRoot (B-820)", () => {
  it("is the active tree's zoom root, and null with nothing focused", () => {
    const { b } = backing();
    const host = createEditorHost({ ...b, zoomRoot: () => "root1" });
    expect(liveEditorHost.zoomRoot()).toBeNull();
    setActiveEditorHost(host);
    expect(liveEditorHost.zoomRoot()).toBe("root1");
    setActiveEditorHost(null);
    expect(liveEditorHost.zoomRoot()).toBeNull();
    releaseEditorHost(host);
  });
});
