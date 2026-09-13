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
 * Highlighting: code fences are highlighted by `render/tokens.tsx#BlockContentView` itself, with
 * highlight.js loaded lazily per language (`render/highlight.ts`; highlight.js over shiki and the
 * bundle numbers are in docs/research/14-render-seams.md). `RenderCtx.highlightCode` can still
 * override it; nothing here does.
 *
 * Long pages (BUILD item 6): `content-visibility: auto` on every `.vr-row` (`editor.css`) is
 * wired — the "zero code" tier 1 research/04-editor.md §5 recommends starting with. Tier 2
 * (virtualization / lazy mounting past ~200 rows) is NOT implemented; the flat row list this
 * component already computes is exactly what research 04 §5 says "makes tier 2 a contained
 * change" later. See the package summary for the actual 1.7 MB-page measurement.
 *
 * Known data-seam gaps (not bugs in this file): no page-existence index (`.vr-ref-new` never
 * renders), `{{embed}}` renders a placeholder rather than a live tree, and `list:: number` is not
 * yet projected by `BlockRow` (numbering is wired end-to-end but always empty) — all three are
 * called out where they bite in `render/tokens.tsx`/`numbering.ts`. `((block refs))` do render
 * their target's text: `BlockRowView` passes `resolveBlockRef` from `data/block-ref-cache.ts`.
 */
import type { EditorView } from "@codemirror/view";
import { formatDayTime, makeOp, type Op, type OutlineNode, serializeOutline } from "@nooklet/core";
import "./editor.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { blockMenuRequest, openBlockMenu } from "../app/context-menu.js";
import {
  createEditorHost,
  releaseEditorHost,
  setActiveContextSnapshot,
  setActiveEditorHost,
} from "../app/editor-host.js";
import { openOnShelf } from "../app/shelf.js";
import { dispatchPopupKey, isPopupOpen } from "../commands/popup-keys.js";
import { displayPageName } from "../data/page-title.js";
import { applyOps, usePageTree } from "../data/store.js";
import type { BlockTreeNode } from "../data/types.js";
import { BlockRowView } from "./BlockRowView.js";
import { getClock } from "./clock.js";
import { rowSurvivesCollapseAll, setAllCollapsedOps } from "./collapse-all.js";
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
import { blockFocusRequest, clearBlockFocusRequest } from "./focus-request.js";
import { EditHistory } from "./history.js";
import { type DispatchCtx, type KeyDescriptor, resolveCommand } from "./keydown.js";
import { linkAtCaret } from "./linkAtCaret.js";
import { deriveNumbering } from "./numbering.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { registerOutline } from "./outline-registry.js";
import { pasteMarkdownAsTree, uploadImageAsset } from "./paste.js";
import type { NavigateTarget } from "./render/tokens.js";
import { createSurface, type Surface } from "./surface.js";
import { cycleMarker, toggleDone } from "./task.js";
import { buildEditorTree, childrenIds, flattenVisible, getBlock } from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditableBlock, EditorTree, FocusChange } from "./types.js";

interface SelectionState {
  anchorId: BlockId;
  focusId: BlockId;
  ids: BlockId[];
}

function toEditableBlock(row: BlockTreeNode): EditableBlock {
  const scheduled =
    row.scheduledDay !== null ? formatDayTime(row.scheduledDay, row.scheduledTime) : null;
  const deadline =
    row.deadlineDay !== null ? formatDayTime(row.deadlineDay, row.deadlineTime) : null;
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

/** A block's first line, trimmed of outline syntax and clipped — for breadcrumbs, where the point
 * is recognition, not the full text. */
function firstLine(content: string): string {
  const line = (content.split("\n")[0] ?? "")
    .replace(/^\s*(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED)\s+/, "")
    .trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "(empty)";
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
      const live = surface.content();
      const idx = flat.findIndex((b) => b.id === editingBlockId);
      if (idx !== -1) {
        // Never let a resource refetch clobber the live CM6 buffer for the block being typed into.
        // This is also NOT the place to notice an external change and push it in: a refetch that
        // READ before one of our own writes and RESOLVED after it looks exactly like "the database
        // disagrees", and doing that here reverted a split mid-keystroke (found fixing B-66).
        // Local operations that change this block's text — undo, redo, a merge — update the
        // editor themselves at commit time (`commit`), where there is nothing to guess.
        flat[idx] = { ...(flat[idx] as EditableBlock), content: live };
      } else {
        // The block being edited is not in this query result yet — it was just created
        // optimistically (Enter for a new sibling) and the write has not committed by the time
        // this refetch resolved. Dropping it here would unmount its row mid-keystroke, detaching
        // the editor and silently swallowing whatever was typed next; the visible symptom was
        // Enter followed by "second bullet" landing as "cond bullet". Keep the local row and let
        // the next refetch, which will contain it, take over.
        const local = untrack(localBlocks).find((b) => b.id === editingBlockId);
        if (local) flat.push({ ...local, content: live });
      }
    }
    // A refetch reorders the edited row too. One that READ before an Alt+Up/Down (or its undo)
    // and RESOLVED after it puts the old order back for a frame, and the next one restores the
    // new order: two DOM moves, each blurring the editor, with nothing to refocus it. Traced
    // 10-40 ms after an undo, where a keystroke typed in that window was lost (B-242).
    const hadFocus = editingBlockId !== null && surface.view()?.hasFocus === true;
    setLocalBlocks(flat);
    if (hadFocus && editingBlockId !== null) refocusAfterReorder(editingBlockId);
  });

  const editorTree = createMemo<EditorTree>(() => buildEditorTree(props.pageId, localBlocks()));

  // Claim a pending "focus this block" request once this tree can actually render the block.
  // The requester is often already unmounted by then (see `./focus-request.ts`), which is why the
  // request lives outside any component.
  createEffect(() => {
    const want = blockFocusRequest();
    if (!want || props.readOnly) return;
    if (!editorTree().byId.has(want)) return;
    clearBlockFocusRequest();
    attachEditing(want, { at: "end" });
  });
  const [localZoomRoot, setLocalZoomRoot] = createSignal<BlockId | undefined>(undefined);
  const effectiveRoot = createMemo(() => localZoomRoot() ?? props.rootBlockId);
  createEffect(() => {
    // A new page or an externally-driven zoom target resets any in-editor zoom-in/out state.
    void props.pageId;
    void props.rootBlockId;
    setLocalZoomRoot(undefined);
  });

  /**
   * Where you are, when zoomed into a block: page name, then each ancestor between it and the
   * zoom root. Without this, zooming just replaced the outline with a shorter one and gave no
   * clue you were no longer looking at the whole page — or how to get back.
   *
   * First line only, and short: this is orientation, not content.
   */
  const zoomTrail = createMemo<Array<{ id: BlockId | null; label: string }>>(() => {
    const root = effectiveRoot();
    if (root === undefined) return [];
    const tree = editorTree();
    const trail: Array<{ id: BlockId | null; label: string }> = [];
    let cursor = tree.byId.get(root)?.parentId ?? null;
    while (cursor !== null) {
      const block = tree.byId.get(cursor);
      if (!block) break;
      trail.unshift({ id: cursor, label: firstLine(block.content) });
      cursor = block.parentId;
    }
    const page = treeResource()?.page;
    if (page) trail.unshift({ id: null, label: displayPageName(page) });
    return trail;
  });

  const rows = createMemo(() => flattenVisible(editorTree(), { rootBlockId: effectiveRoot() }));
  const visibleIds = createMemo(() => rows().map((r) => r.id));
  // Rendering iterates `visibleIds()` (strings, compared by value) rather than `rows()` (fresh
  // objects on every rebuild), so `<For>` reuses each row's DOM instead of recreating it. This is
  // load-bearing, not a micro-optimisation: every keystroke refetches the page resource, which
  // rebuilds `rows()`; keying on those objects tore out the element the single CM6 surface had
  // been re-parented into, so editing died after exactly one character. This map keeps the
  // per-row lookup O(1).
  const rowById = createMemo(() => new Map(rows().map((r) => [r.id, r])));

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
  let outlinerEl: HTMLDivElement | undefined;

  /**
   * Selection mode's keys (`onContainerKeyDown`) only arrive while the outliner root HAS focus.
   * Entering selection detaches the CM6 surface, and removing the focused element sends focus to
   * <body> — so Enter, Escape, Backspace and the arrows all went nowhere (B-44). Call this every
   * time a selection is made.
   */
  function holdSelectionFocus(): void {
    outlinerEl?.focus({ preventScroll: true });
  }

  /**
   * Clicking somewhere else ends editing. Before this the block stayed in edit mode after a click
   * on the page background — its typed `[[link]]` was not followable, the `[[` popup lingered —
   * because the only thing a blur did was flush (B-74). `pointerdown` in the capture phase, not
   * `focusout`: a click on the body is not a focus change (nothing there is focusable), and a
   * click into a popup, menu or the palette must NOT end editing — those belong to the session.
   */
  createEffect(() => {
    if (editingId() === null || props.readOnly) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      if (!target) return;
      if (outlinerEl?.contains(target)) return;
      // A click that closes the context menu is spent on closing it — the block stays in edit
      // mode, caret where the right-click put it. (The menu dismisses itself on this same
      // pointerdown, so by the time a click handler ran it would already be gone; hence the check
      // here, at capture time.)
      if (blockMenuRequest()) return;
      // The zoom breadcrumb is this tree's own chrome, rendered beside the outliner rather than
      // inside it; a click there navigates within the same editing session.
      if (
        target.closest(
          ".cmd-popup, .ctx-menu, .cmd-palette, .cmd-toolbar, .help-menu, .help-keys, .shelf, .vr-zoom-trail",
        )
      )
        return;
      flushPendingEdit();
      surface.detach();
      setEditingId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });
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
    syncSurfaceFromTree();
  }

  /**
   * If the optimistic tree now holds different text for the block being edited — undo, redo, the
   * next block merged into this one — the editor must show it. It used to keep the old buffer:
   * the database changed and the screen did not (B-66). Done synchronously, right after the ops
   * are applied to the local tree, rather than by reconciling against refetches, which cannot
   * tell a stale read from an external change. Unflushed keystrokes still win: they are newer.
   */
  function syncSurfaceFromTree(): void {
    const cur = editingId();
    if (cur === null || surface.currentId() !== cur || pendingEdit !== null) return;
    const next = untrack(editorTree).byId.get(cur)?.content;
    if (next !== undefined && next !== surface.content()) surface.replaceContent(cur, next);
  }

  function flushPendingEdit(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!pendingEdit) return;
    const { id, content, treeBefore, headBefore } = pendingEdit;
    pendingEdit = null;
    // `treeBefore` is the tree as of the first keystroke of this edit. A block created moments
    // earlier (Enter for a new sibling, paste of a subtree) is not in it yet, and the original
    // `!before` guard discarded the edit outright — type immediately after Enter and everything
    // typed was silently thrown away. Absent from the snapshot is not "unchanged": fall back to
    // the live tree, and only skip when the content genuinely has not moved.
    const before = treeBefore.byId.get(id) ?? editorTree().byId.get(id);
    if (before && before.content === content) return;
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

  // Shared by the keyboard dispatch below AND the mobile gestures (swipe-to-indent/outdent,
  // long-press-drag reorder, research/08-mobile.md §3.5/§3.6): exactly the ops
  // `indentBlock`/`outdentBlock`/`moveBlock` (`commands.js`) would build for the Tab/Shift-Tab/
  // Alt+Up/Alt+Down keys, run through the same `runStructural` commit path. A gesture must never
  // be a parallel implementation of these ops.
  function doIndent(id: BlockId): void {
    if (props.readOnly) return;
    const clock = clockSig();
    if (!clock) return;
    const r = indentBlock(editorTree(), id, clock);
    if (r) runStructural({ ops: r.ops });
  }

  function doOutdent(id: BlockId): void {
    if (props.readOnly) return;
    const clock = clockSig();
    if (!clock) return;
    const r = outdentBlock(editorTree(), id, clock, { zoomRootId: effectiveRoot() ?? null });
    if (r) runStructural({ ops: r.ops });
  }

  function doMoveStep(id: BlockId, direction: "up" | "down"): void {
    if (props.readOnly) return;
    const clock = clockSig();
    if (!clock) return;
    const r = moveBlock(editorTree(), id, direction, clock);
    if (!r) return;
    runStructural({ ops: r.ops });
    refocusAfterReorder(id);
  }

  /**
   * Keyed `<For>` reorders by MOVING the row's DOM node, and a moved node loses focus — so after
   * a move the editor was still attached to a block nobody was focused on (B-48). The move
   * happens when Solid reconciles, after the caller returns, so the refocus has to be deferred
   * past it: a microtask for the common case and a frame later as the backstop, the same two-stage
   * dance `surface.attach` does, guarded so a genuine click-away is not fought. Undo and redo of a
   * move reorder the edited row just the same, and so does a refetch (B-242).
   *
   * Only focus that fell to `<body>` is taken back, which is where a moved node leaves it. Since
   * a refetch can land at any moment, focus that went somewhere real in the same frame (Cmd+K
   * into the palette's input) must stay there.
   */
  function refocusAfterReorder(id: BlockId): void {
    if (editingId() !== id) return;
    const refocus = (): void => {
      const active = document.activeElement;
      const fellToBody = active === null || active === document.body;
      if (editingId() === id && fellToBody && !surface.view()?.hasFocus) surface.focus();
    };
    queueMicrotask(refocus);
    requestAnimationFrame(refocus);
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

  /** `block.collapseAll`/`block.expandAll` (R26, B-97) over this page, or the zoomed subtree. */
  function setAllCollapsed(collapsed: boolean): void {
    const clock = clockSig();
    if (props.readOnly || !clock) return;
    flushPendingEdit();
    history.stopCapturing();
    const tree = editorTree();
    const root = effectiveRoot();
    commit(setAllCollapsedOps(tree, root, collapsed, clock), tree, "structure", null, null);
    if (!collapsed) return;
    // The row being edited may just have folded away. An editor left attached to an unmounted row
    // swallows every keystroke after it, so end editing; a selection that lost a row goes too.
    const cur = editingId();
    if (cur !== null && !rowSurvivesCollapseAll(tree, root, cur)) {
      surface.detach();
      setEditingId(null);
    }
    if (selection()?.ids.some((id) => !rowSurvivesCollapseAll(tree, root, id))) setSelection(null);
  }
  // Reachable with nothing focused too: `../app/editor-host.ts`'s no-op host hands page-scoped
  // commands to every registered tree (`./outline-registry.ts`).
  if (!props.readOnly) {
    onCleanup(
      registerOutline((commandId) => {
        if (commandId === "block.collapseAll" || commandId === "block.expandAll") {
          setAllCollapsed(commandId === "block.collapseAll");
        }
      }),
    );
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
    syncSurfaceFromTree();
    if (!res.focus) {
      surface.detach();
      setEditingId(null);
    } else if (res.focus.id === editingId() && surface.currentId() === res.focus.id) {
      // Already editing that block: `attachEditing` would be a no-op (same id, no re-render), so
      // the buffer was synced above and only the caret is left to place.
      surface.setCaret(res.focus.caret);
      refocusAfterReorder(res.focus.id);
    } else {
      attachEditing(res.focus.id, res.focus.caret);
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
    syncSurfaceFromTree();
    if (!res.focus) {
      surface.detach();
      setEditingId(null);
    } else if (res.focus.id === editingId() && surface.currentId() === res.focus.id) {
      // Already editing that block: `attachEditing` would be a no-op (same id, no re-render), so
      // the buffer was synced above and only the caret is left to place.
      surface.setCaret(res.focus.caret);
      refocusAfterReorder(res.focus.id);
    } else {
      attachEditing(res.focus.id, res.focus.caret);
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
      popupOpen: isPopupOpen(),
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
        // R17: a newline inside the block. Not "return false and let CM6 insert it": the global
        // dispatcher has already called preventDefault() by the time this runs (dispatch.ts does so
        // for every matched binding), so CM6's own Enter handling never fires and the keystroke
        // vanished — B-47. Insert it here, through the same view.
        view.dispatch(view.state.replaceSelection("\n"));
        return true;
      case "block.indent":
        doIndent(id);
        return true;
      case "block.outdent":
        doOutdent(id);
        return true;
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
      case "block.moveUp":
        doMoveStep(id, "up");
        return true;
      case "block.moveDown":
        doMoveStep(id, "down");
        return true;
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
      case "block.collapseAll":
      case "block.expandAll":
        setAllCollapsed(cmd === "block.collapseAll");
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
        holdSelectionFocus();
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
    // R12 step 2, made real: while a `[[` / `#` / `((` / `/` popup is open it owns Escape, Enter,
    // Tab and the arrows. The editor keeps focus, so the key arrives here first; the popup's
    // handler consumes it and CM6 preventDefaults. Before this, Enter split the block and Escape
    // dropped into selection mode with the popup still open (B-65).
    if (!kd.mod && !kd.alt && dispatchPopupKey(kd.key)) return true;
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

  // A typed edit is only written after a ~500 ms pause (`onTextChange`'s debounce). Without the
  // listeners below, anything typed in that window is lost outright if the tab is closed, hidden,
  // or reloaded first — the op was never built, so it is not in the local replica either. Both
  // events are the documented ones for "you may never run again"; `visibilitychange` is what
  // actually fires on mobile, where a backgrounded tab can be killed without `pagehide`.
  onMount(() => {
    const flushNow = (): void => flushPendingEdit();
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") flushPendingEdit();
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onHidden);
    onCleanup(() => {
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onHidden);
    });
  });

  // Publish this tree as the command system's `EditorHost` while it owns the shared surface, so
  // the palette, slash menu and `[[`/`#`/`((` popups act on whatever the user is actually editing
  // (`../app/editor-host.ts` explains why this is a live registration and not a singleton).
  const editorHost = createEditorHost({
    currentId: () => surface.currentId(),
    content: () => surface.content(),
    head: () => surface.head(),
    anchor: () => surface.anchor(),
    setText: (id, text, caret) => {
      const view = surface.view();
      if (view && surface.currentId() === id) {
        // Write through the EDITOR, not just the optimistic model. Calling `onTextChange` alone
        // updated `localBlocks` while CodeMirror kept the old buffer, so a formatting command or
        // an autocomplete insertion appeared to do nothing — and the next refetch, which prefers
        // the live buffer for the block being edited, then discarded it outright. The surface's
        // own update listener calls `onTextChange` for us once this dispatch lands.
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } else {
        onTextChange(id as BlockId, text);
      }
      surface.setCaret(typeof caret === "number" ? { offset: caret } : { offset: caret.head });
    },
    runStructural: (id, commandId, _ctx) => {
      const view = surface.view();
      const cmd = commandId as ReturnType<typeof resolveCommand>;
      if (view && id) {
        runCommand(cmd, id as BlockId, view);
        return;
      }
      // No editor attached but a selection standing: this is a selection-mode key (Enter to edit,
      // Backspace to delete, Alt+arrows to move…) that the global dispatcher matched through the
      // context snapshot and has ALREADY preventDefault'ed. Dropping it here left the key doing
      // nothing at all — Enter from selection mode never re-entered editing (B-44).
      const sel = selection();
      if (sel) runSelectionCommand(cmd, sel);
      // Neither: undo/redo after the session ended (`historyEditorHost`, B-241).
      else if (cmd === "edit.undo") doUndo();
      else if (cmd === "edit.redo") doRedo();
    },
    linkAtCaret: () => linkAtCaret(surface.content(), surface.head()),
  });
  createEffect(() => {
    // Depend on `editingId()`, a real signal. The original condition read
    // `surface.currentId()` — a plain closure variable inside `surface.ts`, not anything
    // reactive — so this effect ran exactly once, at mount, when nothing was being edited yet,
    // and never registered the host at all. Everything routed through `EditorHost` was therefore
    // talking to the inert no-op host forever: the slash menu and `[[`/`#`/`((` autocomplete never
    // saw a selection to trigger on, and the formatting commands had nothing to act on.
    // A standing selection needs the context published too: the context menu asks it which
    // entries apply, and a selection made by Cmd/Ctrl+click on a tree that was never edited had
    // no snapshot registered at all (B-73).
    if (editingId() !== null || selection() !== null) {
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
          popupOpen: isPopupOpen(),
          composing: surface.isComposing(),
          zoomed: effectiveRoot() !== undefined,
          focusedBlockId: id,
          selectedBlockIds: sel?.ids ?? [],
          surface,
        };
      });
    } else {
      // Nothing edited, nothing selected: withdraw, so consumers see NOTHING_FOCUSED rather than a
      // snapshot of a session that has ended (the mobile toolbar hides; Escape means nothing).
      setActiveEditorHost(null);
      setActiveContextSnapshot(null);
    }
  });
  onCleanup(() => {
    releaseEditorHost(editorHost);
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
      case "block.copySelection": {
        // R31: the selection as outline markdown, subtrees included, through the same serializer
        // the mirror uses — so what you paste elsewhere is exactly what a page file would say.
        // A block whose ancestor is also selected is already inside that ancestor's subtree.
        const chosen = new Set(sel.ids);
        const inSelectedAncestor = (id: BlockId): boolean => {
          let cur = getBlock(tree, id).parentId;
          while (cur !== null) {
            if (chosen.has(cur)) return true;
            cur = getBlock(tree, cur).parentId;
          }
          return false;
        };
        const toNode = (id: BlockId): OutlineNode => {
          const b = getBlock(tree, id);
          return {
            content: b.content,
            marker: b.marker,
            priority: b.priority,
            properties: {},
            collapsed: b.collapsed,
            children: childrenIds(tree, id).map(toNode),
          };
        };
        const roots = visibleIds().filter((id) => chosen.has(id) && !inSelectedAncestor(id));
        const text = serializeOutline(
          { properties: {}, blocks: roots.map(toNode) },
          { ids: "none" },
        );
        // Registered but never implemented (B-84): Cmd+C on a selection copied nothing at all.
        void navigator.clipboard?.writeText(text);
        return;
      }
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
      case "block.collapseAll":
      case "block.expandAll":
        setAllCollapsed(cmd === "block.collapseAll");
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
    // A key the editor already consumed must not be run again here. The Escape that ENTERS
    // selection mode detaches the surface and focuses this container mid-dispatch, then bubbles
    // up to it — where, with a selection now present, it read as "clear selection" and undid
    // itself (B-44). CM6 calls preventDefault() on every key our keymap handles.
    if (e.defaultPrevented) return;
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

  /** Shift+click, from a row or from a `[[page]]` link inside one (`BlockRowView.tsx` explains why
   * Shift and not something else). The shelf wants a block's page id as well as its own, and this
   * tree is the last place that knows it for free — every row here belongs to `props.pageId`. */
  function onShelfOpen(target: NavigateTarget): void {
    openOnShelf(
      target.kind === "page" ? target : { kind: "block", id: target.id, pageId: props.pageId },
    );
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
    holdSelectionFocus();
  }

  return (
    <>
      <Show when={zoomTrail().length > 0}>
        <nav class="vr-zoom-trail" aria-label="Breadcrumb">
          <For each={zoomTrail()}>
            {(crumb) => (
              <>
                <button
                  type="button"
                  class="vr-crumb"
                  onClick={() => setLocalZoomRoot(crumb.id ?? undefined)}
                >
                  {crumb.label}
                </button>
                <span class="vr-crumb-sep" aria-hidden="true">
                  /
                </span>
              </>
            )}
          </For>
          <span class="vr-crumb-current">
            {firstLine(editorTree().byId.get(effectiveRoot() as BlockId)?.content ?? "")}
          </span>
        </nav>
      </Show>
      <div
        ref={outlinerEl}
        class="vr-outliner"
        role="tree"
        tabindex={-1}
        onKeyDown={onContainerKeyDown}
        // Clicking away is a commit point: don't make the user's edit wait out the debounce when
        // they have visibly moved on. `relatedTarget` is where focus went — null when it left the
        // document entirely, which also counts.
        onFocusOut={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) flushPendingEdit();
        }}
      >
        <For each={visibleIds()}>
          {(id) => {
            // Everything this row needs is read through memos keyed off `id`, so depth, collapse
            // state and content all update this row IN PLACE. `<For>` only ever sees the id string.
            const row = createMemo(() => rowById().get(id));
            const block = createMemo(() => editorTree().byId.get(id));
            return (
              <Show when={row()}>
                {(r) => (
                  <Show when={block()}>
                    {(b) => (
                      <BlockRowView
                        id={id}
                        depth={r().depth}
                        hasChildren={r().hasChildren}
                        collapsed={r().collapsed}
                        childCount={childrenIds(editorTree(), id).length}
                        block={b()}
                        numbering={numbering().get(id)}
                        editing={editingId() === id}
                        selected={selection()?.ids.includes(id) ?? false}
                        surfaceHost={(el) => surfaceHostRef(el, id)}
                        onEnterEdit={(offset) => !props.readOnly && attachEditing(id, { offset })}
                        onToggleCollapse={() => onToggleCollapse(id)}
                        onZoomIn={() => setLocalZoomRoot(id)}
                        onToggleMarker={() => onToggleMarker(id)}
                        onSelectClick={() => onSelectClick(id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Put the caret in the right-clicked block first, so the menu's entries
                          // resolve their `when` clauses against THAT block rather than whatever
                          // happened to be focused before.
                          // …unless the block is part of a standing selection: then the menu is
                          // about the selection (Delete, indent, move), and entering edit mode
                          // would throw it away (B-73).
                          const inSelection = selection()?.ids.includes(id) ?? false;
                          if (!props.readOnly && editingId() !== id && !inSelection)
                            attachEditing(id, { at: "end" });
                          // A microtask, so the menu is built AFTER Solid's effects have run and
                          // registered this tree as the active editor host. Opening it in the same
                          // tick asked every `when` clause about a context that did not exist yet,
                          // and the menu rendered "Nothing available here" until something else
                          // happened to re-open it.
                          const at = { blockId: id, x: e.clientX, y: e.clientY };
                          queueMicrotask(() => openBlockMenu(at));
                        }}
                        onNavigate={props.onNavigate}
                        onShelfOpen={onShelfOpen}
                        onSwipeIndent={() => doIndent(id)}
                        onSwipeOutdent={() => doOutdent(id)}
                        onDragStep={(direction) => doMoveStep(id, direction)}
                      />
                    )}
                  </Show>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </>
  );
}
