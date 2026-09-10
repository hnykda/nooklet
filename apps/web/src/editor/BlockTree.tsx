/**
 * The block tree and its editing surface (this package's whole scope, ADR 006). Owns: the flat
 * row list (`tree.ts#flattenVisible`, respecting collapse and an optional zoom root), the single
 * re-parented CM6 `Surface` (`surface.ts`), block-selection mode, the document-level undo/redo
 * stack (`history.ts`), and turning every edit into ops through the real data seam
 * (`../data/store.ts#applyOps`) — never SQL, never local-only state (task item 4).
 *
 * Text edits are optimistically reflected in a local block list on every keystroke
 * (`optimistic.ts`) so the UI never waits on the worker round trip, then coalesced into one
 * `block.text` op per ~500 ms pause or before any structural op runs (`flushPendingEdit`, task
 * item 4's ordering requirement) — see `history.ts`'s doc comment for why undo/redo mint fresh
 * ops rather than replaying stored ones.
 *
 * Highlighting seam (BUILD item 1's "pick a lightweight highlighter and justify it, or defer
 * behind a clearly-marked seam" choice): DEFERRED. `render/tokens.tsx#BlockContentView` already
 * accepts an optional `highlightCode(code, lang)` prop and falls back to plain, unhighlighted
 * `<code>` when it is absent (which it is here) — no highlighter dependency is wired in this
 * milestone. Justification: CM6 + the tokenizer already spend this package's whole bundle/time
 * budget (research/04-editor.md's own §2.1 numbers put CM6 core alone at ~75 kB brotli before any
 * language support), and a real evaluation of shiki vs. highlight.js/lowlight needs a bundle-size
 * and phone-perf measurement this task's remaining time did not allow; the seam is one function
 * prop away from either.
 *
 * Long pages (BUILD item 6): `content-visibility: auto` on every `.vr-row` (`editor.css`) is
 * wired — the "zero code" tier 1 research/04-editor.md §5 recommends starting with. Tier 2
 * (virtualization / lazy mounting past ~200 rows) is NOT implemented; the flat row list this
 * component already computes is exactly what research 04 §5 says "makes tier 2 a contained
 * change" later. See the package summary for the actual 1.7 MB-page measurement.
 *
 * Known data-seam gaps (not bugs in this file): no page-existence index (`.vr-ref-new` never
 * renders), no cross-page block lookup (`blockRef`/embed render placeholders), and `list::
 * number` is not yet projected by `BlockRow` (numbering is wired end-to-end but always empty) —
 * all three are called out where they bite in `render/tokens.tsx`/`numbering.ts`.
 */
import type { EditorView } from "@codemirror/view";
import { makeOp, type Op } from "@nooklet/core";
import "./editor.css";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  createEditorHost,
  setActiveContextSnapshot,
  setActiveEditorHost,
} from "../app/editor-host.js";
import { applyOps, usePageTree } from "../data/store.js";
import type { BlockTreeNode } from "../data/types.js";
import { BlockRowView } from "./BlockRowView.js";
import { getClock } from "./clock.js";
import {
  blockRefText,
  deleteForwardMerge,
  deleteSelectedBlocks,
  duplicateBlock,
  indentBlock,
  indentSelectedBlocks,
  mergeWithPrevious,
  moveBlock,
  outdentBlock,
  outdentSelectedBlocks,
  setCollapsed,
  splitBlock,
} from "./commands.js";
import { EditHistory } from "./history.js";
import { type DispatchCtx, type KeyDescriptor, resolveCommand } from "./keydown.js";
import { linkAtCaret } from "./linkAtCaret.js";
import { deriveNumbering } from "./numbering.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { pasteMarkdownAsTree, uploadImageAsset } from "./paste.js";
import type { NavigateTarget } from "./render/tokens.js";
import { createSurface, type Surface } from "./surface.js";
import { cycleMarker, toggleDone } from "./task.js";
import { buildEditorTree, childrenIds, flattenVisible } from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditableBlock, EditorTree, FocusChange } from "./types.js";

interface SelectionState {
  anchorId: BlockId;
  focusId: BlockId;
  ids: BlockId[];
}

function dayToIso(day: number): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function toEditableBlock(row: BlockTreeNode): EditableBlock {
  const scheduled =
    row.scheduledDay !== null
      ? dayToIso(row.scheduledDay) + (row.scheduledTime ? ` ${row.scheduledTime}` : "")
      : null;
  const deadline =
    row.deadlineDay !== null
      ? dayToIso(row.deadlineDay) + (row.deadlineTime ? ` ${row.deadlineTime}` : "")
      : null;
  return {
    id: row.id,
    parentId: row.parentId,
    order: row.order,
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    collapsed: row.collapsed,
    scheduled,
    deadline,
    repeat: row.repeat,
    doneAt: row.doneAt,
    // Not yet exposed by the data seam (`numbering.ts`'s doc comment) — always false for now.
    listNumber: false,
  };
}

function flattenBlockTreeNodes(nodes: readonly BlockTreeNode[]): EditableBlock[] {
  const out: EditableBlock[] = [];
  const visit = (ns: readonly BlockTreeNode[]): void => {
    for (const n of ns) {
      out.push(toEditableBlock(n));
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return /Mac|iPhone|iPad|iPod/.test(platform ?? navigator.platform ?? navigator.userAgent);
}

function toKeyDescriptor(e: KeyboardEvent): KeyDescriptor {
  const mac = isMacPlatform();
  return { key: e.key, mod: mac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

function rangeBetween(ids: readonly BlockId[], a: number, b: number): BlockId[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ids.slice(lo, hi + 1);
}

export function BlockTree(props: {
  pageId: string;
  rootBlockId?: string;
  onNavigate?: (t: NavigateTarget) => void;
  readOnly?: boolean;
}) {
  const treeResource = usePageTree(() => props.pageId);
  const [localBlocks, setLocalBlocks] = createSignal<EditableBlock[]>([]);
  const deletedCache = new Map<string, EditableBlock>();

  createEffect(() => {
    const data = treeResource();
    if (!data) return;
    const editingBlockId = editingId();
    const flat = flattenBlockTreeNodes(data.blocks);
    if (editingBlockId && surface.currentId() === editingBlockId) {
      // Never let a resource refetch clobber the live CM6 buffer for the block being typed into.
      const live = surface.content();
      const idx = flat.findIndex((b) => b.id === editingBlockId);
      if (idx !== -1) flat[idx] = { ...(flat[idx] as EditableBlock), content: live };
    }
    setLocalBlocks(flat);
  });

  const editorTree = createMemo<EditorTree>(() => buildEditorTree(props.pageId, localBlocks()));
  const [localZoomRoot, setLocalZoomRoot] = createSignal<BlockId | undefined>(undefined);
  const effectiveRoot = createMemo(() => localZoomRoot() ?? props.rootBlockId);
  createEffect(() => {
    // A new page or an externally-driven zoom target resets any in-editor zoom-in/out state.
    void props.pageId;
    void props.rootBlockId;
    setLocalZoomRoot(undefined);
  });

  const rows = createMemo(() => flattenVisible(editorTree(), { rootBlockId: effectiveRoot() }));
  const visibleIds = createMemo(() => rows().map((r) => r.id));

  const numbering = createMemo(() => {
    const t = editorTree();
    const out = new Map<BlockId, number>();
    for (const ids of t.childrenOf.values()) {
      const derived = deriveNumbering(ids, (id) => t.byId.get(id)?.listNumber ?? false);
      for (const [id, n] of derived) out.set(id, n);
    }
    return out;
  });

  const [editingId, setEditingId] = createSignal<BlockId | null>(null);
  const [selection, setSelection] = createSignal<SelectionState | null>(null);
  const [clockSig, setClockSig] = createSignal<Clock | undefined>(undefined);
  onMount(() => void getClock().then(setClockSig));

  const history = new EditHistory();

  let pendingEdit: {
    id: BlockId;
    content: string;
    treeBefore: EditorTree;
    headBefore: number;
  } | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingCaret: CaretSpec = { at: "end" };

  function commit(
    ops: Op[],
    treeBefore: EditorTree,
    kind: "text" | "structure",
    before: FocusChange | null,
    after: FocusChange | null,
    blockId: BlockId | null = null,
  ): void {
    if (ops.length === 0) return;
    setLocalBlocks((prev) => applyOptimistic(prev, ops as unknown as OptimisticOp[], deletedCache));
    history.record(ops, treeBefore, kind, before, after, blockId);
    void applyOps(ops);
  }

  function flushPendingEdit(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!pendingEdit) return;
    const { id, content, treeBefore, headBefore } = pendingEdit;
    pendingEdit = null;
    const before = treeBefore.byId.get(id);
    if (!before || before.content === content) return;
    const clock = clockSig();
    if (!clock) return;
    const headAfter = surface.currentId() === id ? surface.head() : content.length;
    const op = makeOp(clock.next(), clock.device, id, { kind: "block.text", content });
    history.record(
      [op],
      treeBefore,
      "text",
      { id, caret: { offset: headBefore } },
      { id, caret: { offset: headAfter } },
      id,
    );
    void applyOps([op]);
  }

  function attachEditing(id: BlockId, caret: CaretSpec): void {
    flushPendingEdit();
    history.stopCapturing();
    pendingCaret = caret;
    setSelection(null);
    setEditingId(id);
  }

  function surfaceHostRef(el: HTMLDivElement, forId: BlockId): void {
    const block = editorTree().byId.get(forId);
    surface.attach(el, forId, block?.content ?? "", pendingCaret);
  }

  function runStructural(res: { ops: Op[]; focus?: FocusChange } | null): void {
    flushPendingEdit();
    history.stopCapturing();
    if (!res || res.ops.length === 0) return;
    const treeBefore = editorTree();
    const curId = editingId();
    const before: FocusChange | null = curId
      ? { id: curId, caret: { offset: surface.head() } }
      : null;
    commit(res.ops, treeBefore, "structure", before, res.focus ?? before);
    if (res.focus) attachEditing(res.focus.id, res.focus.caret);
  }

  function commitOne(op: Op): void {
    commit([op], editorTree(), "structure", null, null);
  }

  function doUndo(): void {
    const clock = clockSig();
    if (!clock) return;
    flushPendingEdit();
    const res = history.undo(clock);
    if (!res) return;
    setLocalBlocks((prev) =>
      applyOptimistic(prev, res.ops as unknown as OptimisticOp[], deletedCache),
    );
    void applyOps(res.ops);
    if (res.focus) attachEditing(res.focus.id, res.focus.caret);
    else {
      surface.detach();
      setEditingId(null);
    }
  }

  function doRedo(): void {
    const clock = clockSig();
    if (!clock) return;
    flushPendingEdit();
    const res = history.redo(clock);
    if (!res) return;
    setLocalBlocks((prev) =>
      applyOptimistic(prev, res.ops as unknown as OptimisticOp[], deletedCache),
    );
    void applyOps(res.ops);
    if (res.focus) attachEditing(res.focus.id, res.focus.caret);
    else {
      surface.detach();
      setEditingId(null);
    }
  }

  function buildDispatchCtx(id: BlockId, view: EditorView): DispatchCtx {
    const block = editorTree().byId.get(id);
    const geom = surface.geometry();
    const sel = view.state.selection.main;
    return {
      editorFocused: true,
      blockSelected: false,
      hasSelection: sel.anchor !== sel.head,
      selectionCount: 0,
      atLineStart: geom.atStart,
      atLineEnd: geom.atEnd,
      onFirstVisualLine: geom.onFirstLine,
      onLastVisualLine: geom.onLastLine,
      hasChildren: childrenIds(editorTree(), id).length > 0,
      isCollapsed: block?.collapsed ?? false,
      zoomed: effectiveRoot() !== undefined,
      composing: view.composing,
      popupOpen: false,
    };
  }

  function runCommand(
    cmd: ReturnType<typeof resolveCommand>,
    id: BlockId,
    view: EditorView,
  ): boolean {
    const clock = clockSig();
    if (!clock || !cmd) return false;
    const tree = editorTree();
    switch (cmd) {
      case "block.split":
        runStructural(splitBlock(tree, id, view.state.selection.main.head, clock));
        return true;
      case "block.newline":
        return false; // R17: plain "\n" insertion, left to CM6 itself.
      case "block.indent": {
        const r = indentBlock(tree, id, clock);
        if (r) runStructural({ ops: r.ops });
        return true;
      }
      case "block.outdent": {
        const r = outdentBlock(tree, id, clock, { zoomRootId: effectiveRoot() ?? null });
        if (r) runStructural({ ops: r.ops });
        return true;
      }
      case "block.mergeWithPrevious": {
        const r = mergeWithPrevious(tree, visibleIds(), id, clock);
        if (r) runStructural(r);
        return true;
      }
      case "block.deleteForwardMerge": {
        const r = deleteForwardMerge(tree, visibleIds(), id, clock);
        if (r) runStructural({ ops: r.ops });
        return true;
      }
      case "block.moveUp": {
        const r = moveBlock(tree, id, "up", clock);
        if (r) runStructural({ ops: r.ops });
        return true;
      }
      case "block.moveDown": {
        const r = moveBlock(tree, id, "down", clock);
        if (r) runStructural({ ops: r.ops });
        return true;
      }
      case "block.focusPreviousLine":
      case "block.focusNextLine": {
        const ids = visibleIds();
        const idx = ids.indexOf(id);
        const otherIdx = cmd === "block.focusPreviousLine" ? idx - 1 : idx + 1;
        if (otherIdx < 0 || otherIdx >= ids.length) return false;
        const goalX = surface.geometry().goalX;
        attachEditing(ids[otherIdx] as BlockId, {
          goalX,
          line: cmd === "block.focusPreviousLine" ? "last" : "first",
        });
        return true;
      }
      case "block.focusPreviousChar":
      case "block.focusNextChar": {
        const ids = visibleIds();
        const idx = ids.indexOf(id);
        const otherIdx = cmd === "block.focusPreviousChar" ? idx - 1 : idx + 1;
        if (otherIdx < 0 || otherIdx >= ids.length) return false;
        attachEditing(ids[otherIdx] as BlockId, {
          at: cmd === "block.focusPreviousChar" ? "end" : "start",
        });
        return true;
      }
      case "block.collapse":
        commitOne(setCollapsed(id, true, clock));
        return true;
      case "block.expand":
        commitOne(setCollapsed(id, false, clock));
        return true;
      case "block.zoomIn":
        setLocalZoomRoot(id);
        return true;
      case "block.zoomOut": {
        const cur = effectiveRoot();
        if (!cur) return false;
        setLocalZoomRoot(tree.byId.get(cur)?.parentId ?? undefined);
        return true;
      }
      case "block.selectBlock": {
        surface.detach();
        flushPendingEdit();
        setEditingId(null);
        setSelection({ anchorId: id, focusId: id, ids: [id] });
        return true;
      }
      case "block.extendSelectionUp":
      case "block.extendSelectionDown": {
        const ids = visibleIds();
        const idx = ids.indexOf(id);
        const otherIdx = cmd === "block.extendSelectionUp" ? idx - 1 : idx + 1;
        if (otherIdx < 0 || otherIdx >= ids.length) return false;
        surface.detach();
        flushPendingEdit();
        setEditingId(null);
        setSelection({
          anchorId: id,
          focusId: ids[otherIdx] as BlockId,
          ids: rangeBetween(ids, idx, otherIdx),
        });
        return true;
      }
      case "block.duplicate":
        runStructural(duplicateBlock(tree, id, clock));
        return true;
      case "block.copyRef":
        void navigator.clipboard?.writeText(blockRefText(id));
        return true;
      case "task.cycle": {
        const block = tree.byId.get(id);
        if (!block) return false;
        commit(cycleMarker(block, clock), tree, "structure", null, null);
        return true;
      }
      case "edit.undo":
        doUndo();
        return true;
      case "edit.redo":
        doRedo();
        return true;
      default:
        return false;
    }
  }

  function dispatchKey(id: BlockId, kd: KeyDescriptor, view: EditorView): boolean {
    const ctx = buildDispatchCtx(id, view);
    return runCommand(resolveCommand(kd, ctx), id, view);
  }

  function onTextChange(id: BlockId, content: string): void {
    if (!pendingEdit || pendingEdit.id !== id) {
      pendingEdit = { id, content, treeBefore: editorTree(), headBefore: surface.head() };
    } else {
      pendingEdit.content = content;
    }
    setLocalBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, content } : b)));
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPendingEdit, 500);
  }

  async function handleImagePaste(view: EditorView, file: File): Promise<void> {
    try {
      const asset = await uploadImageAsset(file);
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, to: head, insert: asset.markdown } });
    } catch (err) {
      // R33: "the paste is not applied" — satisfied by not dispatching above. A user-visible
      // error notification is app-chrome this package does not own; logged for now.
      console.error("nooklet: image paste upload failed", err);
    }
  }

  function onPaste(id: BlockId, event: ClipboardEvent, view: EditorView): boolean {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    const imageItem = [...clipboard.items].find((it) => it.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        void handleImagePaste(view, file);
        return true;
      }
    }
    const text = clipboard.getData("text/plain");
    if (!text?.includes("\n")) return false;
    event.preventDefault();
    const clock = clockSig();
    if (!clock) return true;
    runStructural(pasteMarkdownAsTree(editorTree(), id, text, clock));
    return true;
  }

  const surface: Surface = createSurface({ onTextChange, dispatchKey, onPaste });
  onCleanup(() => surface.detach());

  // Publish this tree as the command system's `EditorHost` while it owns the shared surface, so
  // the palette, slash menu and `[[`/`#`/`((` popups act on whatever the user is actually editing
  // (`../app/editor-host.ts` explains why this is a live registration and not a singleton).
  const editorHost = createEditorHost({
    currentId: () => surface.currentId(),
    content: () => surface.content(),
    head: () => surface.head(),
    anchor: () => surface.anchor(),
    setText: (id, text, caret) => {
      onTextChange(id as BlockId, text);
      surface.setCaret(typeof caret === "number" ? { offset: caret } : { offset: caret.head });
    },
    runStructural: (id, commandId, _ctx) => {
      const view = surface.view();
      if (view) runCommand(commandId as ReturnType<typeof resolveCommand>, id as BlockId, view);
    },
    linkAtCaret: () => linkAtCaret(surface.content(), surface.head()),
  });
  createEffect(() => {
    if (surface.currentId() !== null) {
      setActiveEditorHost(editorHost);
      // The command context is recomputed on every read (before each keydown dispatch and each
      // palette/menu render), never cached — the spec's Definitions section requires exactly that.
      setActiveContextSnapshot(() => {
        const id = surface.currentId();
        const sel = selection();
        const block = id ? editorTree().byId.get(id) : undefined;
        const content = surface.content();
        const head = surface.head();
        const geom = surface.geometry();
        return {
          editorFocused: id !== null,
          blockSelected: sel !== null,
          hasSelection: sel !== null || surface.anchor() !== head,
          selectionCount: sel?.ids.length ?? 0,
          isTask: block?.marker != null,
          isCollapsed: block?.collapsed ?? false,
          hasChildren: id ? childrenIds(editorTree(), id).length > 0 : false,
          atLineStart: geom.atStart,
          atLineEnd: geom.atEnd,
          onFirstVisualLine: geom.onFirstLine,
          onLastVisualLine: geom.onLastLine,
          caretInLink: linkAtCaret(content, head) !== null,
          popupOpen: false,
          composing: surface.isComposing(),
          zoomed: effectiveRoot() !== undefined,
          focusedBlockId: id,
          selectedBlockIds: sel?.ids ?? [],
          surface,
        };
      });
    }
  });
  onCleanup(() => {
    setActiveEditorHost(null);
    setActiveContextSnapshot(null);
  });

  function runSelectionCommand(cmd: ReturnType<typeof resolveCommand>, sel: SelectionState): void {
    const clock = clockSig();
    if (!clock || !cmd) return;
    const tree = editorTree();
    switch (cmd) {
      case "block.editSelected":
        attachEditing(sel.focusId, { at: "end" });
        return;
      case "block.clearSelection":
        setSelection(null);
        return;
      case "block.selectAll":
        setSelection({ anchorId: sel.anchorId, focusId: sel.focusId, ids: visibleIds() });
        return;
      case "block.deleteSelected": {
        const r = deleteSelectedBlocks(tree, sel.ids, clock);
        commit(r.ops, tree, "structure", null, null);
        setSelection(null);
        return;
      }
      case "block.indentSelected": {
        const r = indentSelectedBlocks(tree, sel.ids, clock);
        commit(r.ops, tree, "structure", null, null);
        return;
      }
      case "block.outdentSelected": {
        const r = outdentSelectedBlocks(tree, sel.ids, clock);
        commit(r.ops, tree, "structure", null, null);
        return;
      }
      case "block.moveUp":
      case "block.moveDown": {
        const r = moveBlock(tree, sel.focusId, cmd === "block.moveUp" ? "up" : "down", clock);
        if (r) commit(r.ops, tree, "structure", null, null);
        return;
      }
      case "block.collapse":
        commit([setCollapsed(sel.focusId, true, clock)], tree, "structure", null, null);
        return;
      case "block.expand":
        commit([setCollapsed(sel.focusId, false, clock)], tree, "structure", null, null);
        return;
      case "block.extendSelectionUp":
      case "block.extendSelectionDown": {
        const ids = visibleIds();
        const anchorIdx = ids.indexOf(sel.anchorId);
        const focusIdx = ids.indexOf(sel.focusId);
        const nextFocusIdx = cmd === "block.extendSelectionUp" ? focusIdx - 1 : focusIdx + 1;
        if (nextFocusIdx < 0 || nextFocusIdx >= ids.length) return;
        setSelection({
          anchorId: sel.anchorId,
          focusId: ids[nextFocusIdx] as BlockId,
          ids: rangeBetween(ids, anchorIdx, nextFocusIdx),
        });
        return;
      }
      case "block.zoomIn":
        setLocalZoomRoot(sel.focusId);
        return;
      case "block.zoomOut": {
        const cur = effectiveRoot();
        if (!cur) return;
        setLocalZoomRoot(tree.byId.get(cur)?.parentId ?? undefined);
        return;
      }
      case "block.duplicate":
        runStructural(duplicateBlock(tree, sel.focusId, clock));
        return;
      case "block.copyRef":
        void navigator.clipboard?.writeText(blockRefText(sel.focusId));
        return;
      case "task.cycle": {
        if (sel.ids.length !== 1) return;
        const block = tree.byId.get(sel.focusId);
        if (!block) return;
        commit(cycleMarker(block, clock), tree, "structure", null, null);
        return;
      }
      case "edit.undo":
        doUndo();
        return;
      case "edit.redo":
        doRedo();
        return;
      default:
        return;
    }
  }

  function onContainerKeyDown(e: KeyboardEvent): void {
    if (props.readOnly) return;
    if (editingId()) return; // the CM6 surface's own keymap already handles this
    const sel = selection();
    const kd = toKeyDescriptor(e);
    const ctx: DispatchCtx = {
      editorFocused: false,
      blockSelected: sel !== null,
      hasSelection: sel !== null,
      selectionCount: sel?.ids.length ?? 0,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      hasChildren: sel ? childrenIds(editorTree(), sel.focusId).length > 0 : false,
      isCollapsed: sel ? (editorTree().byId.get(sel.focusId)?.collapsed ?? false) : false,
      zoomed: effectiveRoot() !== undefined,
      composing: false,
      popupOpen: false,
    };
    const cmd = resolveCommand(kd, ctx);
    if (!cmd) return;
    e.preventDefault();
    if (sel) runSelectionCommand(cmd, sel);
    else if (cmd === "edit.undo") doUndo();
    else if (cmd === "edit.redo") doRedo();
  }

  function onToggleCollapse(id: BlockId): void {
    const clock = clockSig();
    const block = editorTree().byId.get(id);
    if (!clock || !block) return;
    commitOne(setCollapsed(id, !block.collapsed, clock));
  }

  function onToggleMarker(id: BlockId): void {
    const clock = clockSig();
    const block = editorTree().byId.get(id);
    if (!clock || !block) return;
    commit(toggleDone(block, clock), editorTree(), "structure", null, null);
  }

  function onSelectClick(id: BlockId): void {
    const ids = visibleIds();
    const existing = selection();
    if (existing) {
      const anchorIdx = ids.indexOf(existing.anchorId);
      const clickedIdx = ids.indexOf(id);
      if (anchorIdx !== -1 && clickedIdx !== -1) {
        setSelection({
          anchorId: existing.anchorId,
          focusId: id,
          ids: rangeBetween(ids, anchorIdx, clickedIdx),
        });
        return;
      }
    }
    surface.detach();
    flushPendingEdit();
    setEditingId(null);
    setSelection({ anchorId: id, focusId: id, ids: [id] });
  }

  return (
    <div class="vr-outliner" role="tree" tabindex={-1} onKeyDown={onContainerKeyDown}>
      <For each={rows()}>
        {(row) => {
          const block = createMemo(() => editorTree().byId.get(row.id));
          return (
            <Show when={block()}>
              {(b) => (
                <BlockRowView
                  id={row.id}
                  depth={row.depth}
                  hasChildren={row.hasChildren}
                  collapsed={row.collapsed}
                  childCount={childrenIds(editorTree(), row.id).length}
                  block={b()}
                  numbering={numbering().get(row.id)}
                  editing={editingId() === row.id}
                  selected={selection()?.ids.includes(row.id) ?? false}
                  surfaceHost={(el) => surfaceHostRef(el, row.id)}
                  onEnterEdit={(offset) => !props.readOnly && attachEditing(row.id, { offset })}
                  onToggleCollapse={() => onToggleCollapse(row.id)}
                  onZoomIn={() => setLocalZoomRoot(row.id)}
                  onToggleMarker={() => onToggleMarker(row.id)}
                  onSelectClick={() => onSelectClick(row.id)}
                  onNavigate={props.onNavigate}
                />
              )}
            </Show>
          );
        }}
      </For>
    </div>
  );
}
