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
 * Known data-seam gap (not a bug in this file): no page-existence index, so `.vr-ref-new` never
 * renders — called out where it bites in `render/tokens.tsx`. `((block refs))` do render their
 * target's text: `BlockRowView` passes `resolveBlockRef` from `data/block-ref-cache.ts`. And
 * `{{embed}}` renders its target read-only through `render/EmbedView.tsx` (B-210); editing
 * happens where the block lives.
 */
import type { EditorView } from "@codemirror/view";
import {
  blockTextPayloads,
  formatDayTime,
  makeOp,
  newId,
  type Op,
  orderBetween,
} from "@nooklet/core";
import "./editor.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { blockMenuRequest, openBlockMenu } from "../app/context-menu.js";
import {
  createEditorHost,
  registerEditorHost,
  releaseEditorHost,
  setActiveContextSnapshot,
  setActiveEditorHost,
} from "../app/editor-host.js";
import { isPrinting } from "../app/print.js";
import { openOnShelf } from "../app/shelf.js";
import { dispatchPopupKey, isPopupOpen } from "../commands/popup-keys.js";
import { displayPageName } from "../data/page-title.js";
import { applyOps, usePageProperties, usePageTree } from "../data/store.js";
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
import {
  caretInEditText,
  contentOffsetOf,
  editTextMatches,
  editTextOf,
  withEditText,
} from "./editText.js";
import { prepareExternalBatch } from "./external-batch.js";
import {
  blockFocusCaret,
  blockFocusRequest,
  clearBlockFocusRequest,
  editingEndRequest,
  requestEditingEnd,
} from "./focus-request.js";
import { EditHistory, type UndoRedoResult } from "./history.js";
import { insertAt, pickImageFile } from "./imagePicker.js";
import { type DispatchCtx, type KeyDescriptor, resolveCommand } from "./keydown.js";
import { linkAtCaret } from "./linkAtCaret.js";
import { mergeRefusedMessage } from "./merge-fields.js";
import { deriveNumbering, isNumbered } from "./numbering.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { registerOutline, registerTypingFlush } from "./outline-registry.js";
import { filterVisible } from "./pageFilter.js";
import { pasteMarkdownAsTree, uploadImageAsset } from "./paste.js";
import { createReadOnlyNotice } from "./ReadOnlyNotice.js";
import { isReadOnlyValue, READ_ONLY_PROPERTY } from "./readOnly.js";
import { mapThroughRewrite, TextVersions } from "./remote-text.js";
import type { NavigateTarget } from "./render/tokens.js";
import { cutToClipboard, selectionMarkdown } from "./selection-clipboard.js";
import { createSurface, type Surface } from "./surface.js";
import { cycleMarker, toggleDone } from "./task.js";
import { buildEditorTree, childrenIds, flattenVisible } from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditableBlock, EditorTree, FocusChange } from "./types.js";
import { focusAfterStep } from "./undo-focus.js";
import { UnseenCreations } from "./unseen-creations.js";

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
    // Generic properties, projected by the worker (B-100): `list:: number`, property chips.
    properties: row.properties,
  };
}

function flattenBlockTreeNodes(
  nodes: readonly BlockTreeNode[],
  contentHlcs: Map<string, string>,
): EditableBlock[] {
  const out: EditableBlock[] = [];
  const visit = (ns: readonly BlockTreeNode[]): void => {
    for (const n of ns) {
      out.push(toEditableBlock(n));
      contentHlcs.set(n.id, n.contentHlc);
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
  /** Find in page (`./pageFilter.ts`): while non-blank, only matching blocks and their ancestors
   * are shown. Purely visual — no op is written. */
  filter?: string;
  /** The matching block ids in reading order, on every change while `filter` is set. */
  onFilterMatches?: (ids: readonly string[]) => void;
  /** A batch the caller has just applied to this page, drawn before the first fetch answers, so a
   * focus request for a block in it is claimed on mount rather than a worker round trip later —
   * keys typed in that gap had no editor (B-411, `views/VirtualJournalDay.tsx`). Read once. */
  initialOps?: readonly Op[];
}) {
  const treeResource = usePageTree(() => props.pageId);
  // The read-only page lock (`./readOnly.ts`): the prop, or the page's own `read-only:: true`.
  // Read here rather than passed in, so every tree showing the page — the page view, a day in the
  // journal stream — honours it without each host remembering to.
  const pageProperties = usePageProperties(() => props.pageId);
  const readOnly = createMemo(
    () => props.readOnly === true || isReadOnlyValue(pageProperties()[READ_ONLY_PROPERTY]),
  );
  const readOnlyNotice = createReadOnlyNotice();
  const deletedCache = new Map<string, EditableBlock>();
  const initialOps = (props.initialOps ?? []) as unknown as OptimisticOp[];
  const [localBlocks, setLocalBlocks] = createSignal<EditableBlock[]>(
    applyOptimistic([], initialOps, deletedCache),
  );
  const unseenCreations = new UnseenCreations();
  unseenCreations.note(props.initialOps ?? []);
  /**
   * The buffer of each block whose flushed text write the worker has not answered yet (B-303).
   * The effect below also re-runs when editing ENDS, against the page tree it fetched before that
   * flush — so without this, Escape put the last-fetched text back on screen until the write came
   * back (12–20 ms idle, seconds behind a busy worker), and a Cut in that window copied the old
   * text and deleted the block holding the new one. Held only until the answer: the worker runs
   * messages in order, so any page tree that resolves after it was read after the write. A later
   * local op on the block other than a move (undo, redo, a merge, a delete) drops the entry: the
   * optimistic tree holds the newer state then, and the flushed buffer must not be put back over
   * it. (Undo straight after Escape behaved the same in a probe with or without the drop; it is
   * there by reasoning, not because a failure was seen.)
   */
  const unansweredText = new Map<BlockId, { content: string }>();
  function supersedeUnansweredText(ops: readonly Op[]): void {
    for (const op of ops) if (op.payload.kind !== "block.place") unansweredText.delete(op.entity);
  }
  /** Which fetched texts are newer than anything this tree showed or wrote (B-192). */
  const textVersions = new TextVersions();
  textVersions.noteWrites(props.initialOps ?? []);
  /** A newer text of the block being edited that arrived over unsaved typing, offered on its row
   * (B-192): its editing text, and the `content_hlc` it was fetched with. */
  const [remoteOffer, setRemoteOffer] = createSignal<{
    id: BlockId;
    hlc: string;
    text: string;
  } | null>(null);

  createEffect(() => {
    const data = treeResource();
    if (!data) return;
    const editingBlockId = editingId();
    const contentHlcs = new Map<BlockId, string>();
    const flat = flattenBlockTreeNodes(data.blocks, contentHlcs);
    unseenCreations.seen(flat.map((b) => b.id));
    const attachedId =
      editingBlockId && surface.currentId() === editingBlockId ? editingBlockId : null;
    const fetchedEdited = attachedId ? flat.find((b) => b.id === attachedId) : undefined;
    for (let i = 0; i < flat.length; i++) {
      const id = (flat[i] as EditableBlock).id;
      const written = unansweredText.get(id);
      if (written) flat[i] = withEditText(flat[i] as EditableBlock, written.content);
      // What the screen shows is the fetched text (B-192) — unless an unanswered write stands in
      // for it, or it is the editor's block, which is decided below.
      else if (id !== attachedId) textVersions.noteShown(id, contentHlcs.get(id) as string);
    }
    let takeIntoEditor: string | null = null;
    if (editingBlockId && surface.currentId() === editingBlockId) {
      const live = surface.content();
      const idx = flat.findIndex((b) => b.id === editingBlockId);
      if (idx !== -1 && fetchedEdited) {
        // Never let a STALE refetch clobber the live CM6 buffer for the block being typed into: a
        // refetch that READ before one of our own writes and RESOLVED after it looks exactly like
        // "the database disagrees", and pushing it in reverted a split mid-keystroke (B-66). What
        // tells the two apart is the text's `content_hlc` against this tree's own writes
        // (`./remote-text.ts`), not timing. Only a text newer than both reaches the editor, and
        // only with nothing unsaved in it; over unsaved typing it is offered on the row (B-192).
        // Local operations that change this block's text — undo, redo, a merge — still update the
        // editor themselves at commit time (`commit`). The buffer holds property lines too (B-101),
        // so it is split back into content and properties rather than copied into `content`.
        const hlc = contentHlcs.get(editingBlockId) as string;
        const verdict = untrack(() =>
          textVersions.decide(editingBlockId, hlc, {
            sameText: editTextMatches(fetchedEdited, live),
            unsaved: hasUnsavedTyping(editingBlockId),
          }),
        );
        if (verdict === "take") {
          flat[idx] = fetchedEdited;
          takeIntoEditor = editTextOf(fetchedEdited);
        } else {
          flat[idx] = withEditText(flat[idx] as EditableBlock, live);
        }
        if (verdict === "offer") {
          setRemoteOffer({ id: editingBlockId, hlc, text: editTextOf(fetchedEdited) });
        } else if (verdict === "take" || verdict === "same") {
          if (untrack(remoteOffer)?.id === editingBlockId) setRemoteOffer(null);
        }
      } else if (unseenCreations.has(editingBlockId)) {
        // The block being edited is not in this query result yet — it was just created
        // optimistically (Enter for a new sibling) and the write has not committed by the time
        // this refetch resolved. Dropping it here would unmount its row mid-keystroke, detaching
        // the editor and silently swallowing whatever was typed next; the visible symptom was
        // Enter followed by "second bullet" landing as "cond bullet". Keep the local row and let
        // the next refetch, which will contain it, take over.
        const local = untrack(localBlocks).find((b) => b.id === editingBlockId);
        if (local) flat.push(withEditText(local, live));
      } else {
        // The block being edited was in the database and no longer is on this page: deleted or
        // moved away by another device, an agent, or a server-side refactor. Keeping its row (what
        // every absence used to get) left it on screen with the old text until the next click
        // (B-88). End editing like a click-away does; unflushed keystrokes are still written, to
        // the block by id, wherever it went. Untracked: this effect must not start depending on
        // what `flushPendingEdit` reads.
        untrack(() => {
          flushPendingEdit();
          surface.detach();
          setEditingId(null);
        });
      }
    }
    // A refetch reorders the edited row too. One that READ before an Alt+Up/Down (or its undo)
    // and RESOLVED after it puts the old order back for a frame, and the next one restores the
    // new order: two DOM moves, each blurring the editor, with nothing to refocus it. Traced
    // 10-40 ms after an undo, where a keystroke typed in that window was lost (B-242).
    const hadFocus = editingBlockId !== null && surface.view()?.hasFocus === true;
    setLocalBlocks(flat);
    const takeText = takeIntoEditor;
    if (takeText !== null && editingBlockId !== null) {
      untrack(() => takeRemoteText(editingBlockId, takeText));
    }
    if (hadFocus && editingBlockId !== null) refocusAfterReorder(editingBlockId);
  });
  // An offer is about the block being edited; once editing moves on, the buffer was flushed and
  // what it wrote is the answer.
  createEffect(() => {
    const offer = remoteOffer();
    if (offer && editingId() !== offer.id) setRemoteOffer(null);
  });

  const editorTree = createMemo<EditorTree>(() => buildEditorTree(props.pageId, localBlocks()));

  // Claim a pending "focus this block" request once this tree can actually render the block.
  // The requester is often already unmounted by then (see `./focus-request.ts`), which is why the
  // request lives outside any component.
  createEffect(() => {
    const want = blockFocusRequest();
    if (!want || readOnly()) return;
    if (!editorTree().byId.has(want)) return;
    // In the tree but not on screen — under a collapsed parent, or outside the zoom root. Find in
    // page can hand back such a block (it was showing while the filter was on); attaching to it
    // would put the editor in a row that is not rendered, with the keyboard going nowhere.
    if (!rowById().has(want)) {
      clearBlockFocusRequest();
      return;
    }
    const caret = blockFocusCaret() ?? { at: "end" };
    clearBlockFocusRequest();
    attachEditing(want, caret);
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

  // Declared here rather than with the rest of the editing state below: `filtered` reads it, and
  // a memo runs as soon as it is created.
  const [editingId, setEditingId] = createSignal<BlockId | null>(null);
  const filtered = createMemo(() => {
    const q = props.filter;
    // Paper gets the page, not the find: the whole outline with collapsed children expanded
    // (`rows` below), no faded ancestors. An active filter used to win over printing, and the
    // print was just the matches (B-363). `afterprint` brings the filter back as it was.
    if (!q || isPrinting()) return null;
    return filterVisible(editorTree(), q, { rootBlockId: effectiveRoot(), keep: editingId() });
  });
  const findMatches = createMemo(() => {
    const f = filtered();
    return f ? new Set(f.matches) : null;
  });
  createEffect(() => {
    const f = filtered();
    if (f) props.onFilterMatches?.(f.matches);
  });
  // While printing, collapsed children are rendered too, or the printed page silently loses them
  // (B-221, `../app/print.ts`).
  const rows = createMemo(
    () =>
      filtered()?.rows ??
      flattenVisible(editorTree(), { rootBlockId: effectiveRoot(), expandAll: isPrinting() }),
  );
  const visibleIds = createMemo(() => rows().map((r) => r.id));
  /**
   * The page's reading order as if no find filter were on. A merge (Backspace at the start, Delete
   * at the end) joins a block with its neighbour ON THE PAGE; under a filter the neighbouring row
   * on screen can be many hidden blocks away, and joining with it moved the text above blocks it
   * never touched ("keep me" / hidden / "keep too" became "keep mekeep too" / hidden). A match with
   * no row here (under a collapsed parent) makes the merge a no-op, as it would be unfiltered.
   */
  const outlineOrder = (): BlockId[] =>
    filtered()
      ? flattenVisible(editorTree(), { rootBlockId: effectiveRoot() }).map((r) => r.id)
      : visibleIds();
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
      const derived = deriveNumbering(ids, (id) => isNumbered(t.byId.get(id)));
      for (const [id, n] of derived) out.set(id, n);
    }
    return out;
  });

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
    if (editingId() === null || readOnly()) return;
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
      // inside it; a click there navigates within the same editing session. So are the find bar's
      // buttons (not its input, which takes the keyboard): they keep focus where it is, and a
      // click on "close" while typing in a match ended the edit it meant to leave alone.
      if (
        target.closest(
          ".cmd-popup, .ctx-menu, .cmd-palette, .cmd-toolbar, .help-menu, .help-keys, .shelf, .vr-zoom-trail, .page-find-button",
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
  // `requestEditingEnd()` (`./focus-request.ts`): something outside the outline took the keyboard.
  createEffect(
    on(
      editingEndRequest,
      () => {
        if (editingId() !== null) {
          flushPendingEdit();
          surface.detach();
          setEditingId(null);
        }
        setSelection(null);
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (!readOnly()) return;
    untrack(() => {
      if (editingId() !== null) {
        flushPendingEdit();
        surface.detach();
        setEditingId(null);
      }
      setSelection(null);
    });
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
    unseenCreations.note(ops);
    textVersions.noteWrites(ops);
    supersedeUnansweredText(ops);
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
    const block = untrack(editorTree).byId.get(cur);
    // Compared as content + properties, not as text: the buffer may list property lines in another
    // order, or anywhere below line 1, and rewriting it for that would jump the caret mid-edit.
    if (block && !editTextMatches(block, surface.content())) {
      surface.replaceContent(cur, editTextOf(block));
    }
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
    // `content` here is the whole buffer: the block's text plus its `key:: value` lines. What gets
    // written is the difference from `before` — a `block.text` if the text moved, one `block.prop`
    // per property line added, changed or removed (B-101). Writing the buffer verbatim is what made
    // `/property` (and any typed property line) land in the text, where nothing reads it as one.
    const payloads = blockTextPayloads(before ?? { content: "", properties: {} }, content);
    if (before && payloads.length === 0) return;
    const clock = clockSig();
    if (!clock) return;
    const ops =
      payloads.length > 0
        ? payloads.map((p) => makeOp(clock.next(), clock.device, id, p))
        : [makeOp(clock.next(), clock.device, id, { kind: "block.text", content })];
    textVersions.noteWrites(ops);
    // Carets in history are content offsets, like every other `CaretSpec` in this file; they are
    // mapped back into the buffer when the surface re-attaches (`caretInEditText`).
    const headAfter = surface.currentId() === id ? surface.head() : content.length;
    history.record(
      ops,
      treeBefore,
      "text",
      { id, caret: { offset: headBefore } },
      { id, caret: { offset: contentOffsetOf(content, headAfter) } },
      id,
    );
    const written = { content };
    unansweredText.set(id, written);
    const answered = () => {
      if (unansweredText.get(id) === written) unansweredText.delete(id);
    };
    void applyOps(ops).then(answered, answered);
  }

  /** Typing in `id` that `flushPendingEdit` would still write (B-192). The pending edit that
   * `surface.replaceContent` streams back after a buffer sync writes nothing, and is not typing. */
  function hasUnsavedTyping(id: BlockId): boolean {
    if (!pendingEdit || pendingEdit.id !== id) return false;
    const before = pendingEdit.treeBefore.byId.get(id) ?? untrack(editorTree).byId.get(id);
    return !before || blockTextPayloads(before, pendingEdit.content).length > 0;
  }

  function dropPendingEdit(): void {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    pendingEdit = null;
  }

  /** A newer text from elsewhere, with nothing unsaved in the editor: put it in, the caret mapped
   * through the change (B-192). The tree already holds it; nothing is written. */
  function takeRemoteText(id: BlockId, text: string): void {
    const view = surface.view();
    if (!view || surface.currentId() !== id) return;
    const before = surface.content();
    const { anchor, head } = view.state.selection.main;
    surface.replaceContent(id, text, {
      anchor: mapThroughRewrite(before, text, anchor),
      head: mapThroughRewrite(before, text, head),
    });
    // The replacement came back through `onTextChange` as a pending edit equal to the tree.
    dropPendingEdit();
  }

  /**
   * "Use the other version" (B-192): the offered text replaces the typing. Written, not only shown
   * — the typing may have been saved already, over it — and as one undo step, whose undo puts the
   * typing back. Keystrokes not yet written are dropped rather than written first: the person chose
   * the other version, and a write of theirs would reach other devices only to be overwritten.
   */
  function takeRemoteOffer(): void {
    const offer = remoteOffer();
    setRemoteOffer(null);
    const clock = clockSig();
    if (!offer || !clock || readOnly()) return;
    const { id, text } = offer;
    dropPendingEdit();
    history.stopCapturing();
    textVersions.taken(id, offer.hlc);
    const tree = editorTree();
    const block = tree.byId.get(id);
    if (!block) return;
    const payloads = blockTextPayloads(block, text);
    if (payloads.length === 0) return;
    const editing = surface.currentId() === id;
    const live = editing ? surface.content() : editTextOf(block);
    const head = editing ? surface.head() : live.length;
    const headAfter = mapThroughRewrite(live, text, head);
    commit(
      payloads.map((p) => makeOp(clock.next(), clock.device, id, p)),
      tree,
      "structure",
      { id, caret: { offset: contentOffsetOf(live, head) } },
      { id, caret: { offset: contentOffsetOf(text, headAfter) } },
    );
    // `commit` synced the buffer (caret clamped) and streamed a pending edit that writes nothing.
    dropPendingEdit();
    if (editing) surface.setCaret({ offset: headAfter });
  }

  function attachEditing(id: BlockId, caret: CaretSpec): void {
    flushPendingEdit();
    history.stopCapturing();
    pendingCaret = caret;
    setSelection(null);
    setEditingId(id);
  }

  /** A content-relative caret for block `id`, as an offset into its buffer. */
  function bufferCaret(id: BlockId, caret: CaretSpec): CaretSpec {
    const block = editorTree().byId.get(id);
    return block ? caretInEditText(block, caret) : caret;
  }

  function surfaceHostRef(el: HTMLDivElement, forId: BlockId): void {
    const block = editorTree().byId.get(forId);
    // The buffer is the block's editing text — content plus its property lines — and the caret,
    // computed against content by whoever asked for this block, is moved to match (B-101).
    if (!block) {
      surface.attach(el, forId, "", pendingCaret);
      return;
    }
    surface.attach(el, forId, editTextOf(block), caretInEditText(block, pendingCaret));
  }

  // Shared by the keyboard dispatch below AND the mobile gestures (swipe-to-indent/outdent,
  // long-press-drag reorder, research/08-mobile.md §3.5/§3.6): exactly the ops
  // `indentBlock`/`outdentBlock`/`moveBlock` (`commands.js`) would build for the Tab/Shift-Tab/
  // Alt+Up/Alt+Down keys, run through the same `runStructural` commit path. A gesture must never
  // be a parallel implementation of these ops.
  function doIndent(id: BlockId): void {
    if (readOnly()) {
      readOnlyNotice.show();
      return;
    }
    const clock = clockSig();
    if (!clock) return;
    const r = indentBlock(editorTree(), id, clock);
    if (r) runStructural({ ops: r.ops });
  }

  function doOutdent(id: BlockId): void {
    if (readOnly()) {
      readOnlyNotice.show();
      return;
    }
    const clock = clockSig();
    if (!clock) return;
    const r = outdentBlock(editorTree(), id, clock, { zoomRootId: effectiveRoot() ?? null });
    if (r) runStructural({ ops: r.ops });
  }

  function doMoveStep(id: BlockId, direction: "up" | "down"): void {
    if (readOnly()) {
      readOnlyNotice.show();
      return;
    }
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
      ? { id: curId, caret: { offset: contentOffsetOf(surface.content(), surface.head()) } }
      : null;
    commit(res.ops, treeBefore, "structure", before, res.focus ?? before);
    if (!res.focus) return;
    // Focus staying on the block being edited (a command's batch written into it, B-108): the
    // buffer was synced by `commit`, and `attachEditing` with the same id re-renders nothing, so
    // the caret would never move. Same case as in `doUndo`, and like there the caret is a CONTENT
    // caret that has to be mapped into the buffer: set as-is, `/template`'s `{at: "end"}` in an
    // empty numbered item landed after `list:: number` and the next keystroke edited that (B-360).
    if (res.focus.id === editingId() && surface.currentId() === res.focus.id)
      surface.setCaret(bufferCaret(res.focus.id, res.focus.caret));
    else attachEditing(res.focus.id, res.focus.caret);
  }

  function commitOne(op: Op): void {
    commitStep([op]);
  }

  /** A write from a key or a click that records no caret — collapse, expand, a marker — as its own
   * undo step. Keystrokes still inside the write debounce are flushed FIRST, as `runStructural`
   * does: recorded later, they landed above this step, and Cmd/Ctrl+Z took back the typing before
   * the collapse that came after it (B-280). */
  function commitStep(ops: Op[]): void {
    flushPendingEdit();
    history.stopCapturing();
    commit(ops, editorTree(), "structure", null, null);
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

  /**
   * Undo and redo write, so a locked page refuses them like every other writer here. They need
   * their own check: after a session ends Cmd/Ctrl+Z still reaches this tree through
   * `historyEditorHost` (B-241) — and locking is one of the things that ends a session, so the
   * edit the lock had just stopped was reverted on the locked page, editor and all (B-362).
   */
  function refuseHistoryWhenLocked(): boolean {
    if (!readOnly()) return false;
    readOnlyNotice.show();
    return true;
  }

  function doUndo(): void {
    if (refuseHistoryWhenLocked()) return;
    const clock = clockSig();
    if (!clock) return;
    flushPendingEdit();
    applyHistoryStep(history.undo(clock, stillInTree));
  }

  function doRedo(): void {
    if (refuseHistoryWhenLocked()) return;
    const clock = clockSig();
    if (!clock) return;
    flushPendingEdit();
    applyHistoryStep(history.redo(clock, stillInTree));
  }

  /** A block an undo or redo may write to (B-194, `history.ts#reachable`): in this tree, or created
   * here and not yet returned by a refetch — a stale refetch can leave such a block out for a
   * moment, and its step is not gone for that. */
  function stillInTree(id: BlockId): boolean {
    return untrack(editorTree).byId.has(id) || unseenCreations.has(id);
  }

  function applyHistoryStep(res: UndoRedoResult | null): void {
    if (!res) return;
    unseenCreations.note(res.ops);
    textVersions.noteWrites(res.ops);
    supersedeUnansweredText(res.ops);
    setLocalBlocks((prev) =>
      applyOptimistic(prev, res.ops as unknown as OptimisticOp[], deletedCache),
    );
    void applyOps(res.ops);
    syncSurfaceFromTree();
    // Rows as they are AFTER the step (B-162, B-194: `./undo-focus.ts`).
    const next = focusAfterStep(res.focus, editingId(), (id) => untrack(rowById).has(id));
    if (next.kind === "detach") {
      surface.detach();
      setEditingId(null);
    } else if (next.kind === "keep") {
      const cur = editingId();
      if (cur !== null) refocusAfterReorder(cur);
    } else if (next.focus.id === editingId() && surface.currentId() === next.focus.id) {
      // Already editing that block: `attachEditing` would be a no-op (same id, no re-render), so
      // the buffer was synced above and only the caret is left to place.
      surface.setCaret(bufferCaret(next.focus.id, next.focus.caret));
      refocusAfterReorder(next.focus.id);
    } else {
      attachEditing(next.focus.id, next.focus.caret);
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
        // The caret is in the buffer, which may hold property lines; the split divides content.
        runStructural(
          splitBlock(
            tree,
            id,
            contentOffsetOf(view.state.doc.toString(), view.state.selection.main.head),
            clock,
          ),
        );
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
        const r = mergeWithPrevious(tree, outlineOrder(), id, clock);
        if (r && "refused" in r) readOnlyNotice.show(mergeRefusedMessage(r.refused));
        else if (r) runStructural(r);
        return true;
      }
      case "block.deleteForwardMerge": {
        const r = deleteForwardMerge(tree, outlineOrder(), id, clock);
        if (r && "refused" in r) readOnlyNotice.show(mergeRefusedMessage(r.refused));
        else if (r) runStructural({ ops: r.ops });
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
        commitStep(cycleMarker(block, clock));
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
      pendingEdit = {
        id,
        content,
        treeBefore: editorTree(),
        headBefore: contentOffsetOf(content, surface.head()),
      };
    } else {
      pendingEdit.content = content;
    }
    // `content` is the buffer: split it, so the tree keeps content and properties apart (B-101).
    setLocalBlocks((prev) => prev.map((b) => (b.id === id ? withEditText(b, content) : b)));
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPendingEdit, 500);
  }

  /**
   * Upload an image (paste, `/image`) and put its markdown into block `id`. The upload takes a
   * network round trip, and the editor may have moved on by the time it lands: it used to dispatch
   * into whatever block the single surface was attached to THEN, so clicking another block while a
   * paste uploaded put the picture there. Still on `id`: insert at the live caret. Moved on: write
   * it into `id`'s content at the caret it had when the insert was asked for.
   */
  async function insertUploadedImage(id: BlockId, file: File): Promise<void> {
    const askedAt =
      surface.currentId() === id ? contentOffsetOf(surface.content(), surface.head()) : 0;
    try {
      const asset = await uploadImageAsset(file);
      const view = surface.view();
      if (view && surface.currentId() === id) {
        const head = view.state.selection.main.head;
        // With no `selection`, CM6 maps a caret sitting exactly at the insertion point to BEFORE
        // the inserted text, so the next keystroke landed in front of the image (B-343).
        view.dispatch({
          changes: { from: head, to: head, insert: asset.markdown },
          selection: { anchor: head + asset.markdown.length },
        });
        return;
      }
      const clock = clockSig();
      const block = editorTree().byId.get(id);
      if (!clock || !block) return;
      const content = insertAt(block.content, askedAt, asset.markdown);
      commitOne(makeOp(clock.next(), clock.device, id, { kind: "block.text", content }));
    } catch (err) {
      // R33: "the paste is not applied" — satisfied by not inserting above. A user-visible
      // error notification is app-chrome this package does not own; logged for now.
      console.error("nooklet: image upload failed", err);
    }
  }

  /** `/image` (B-99): the platform's own file chooser, then the same upload-and-insert as paste. */
  async function insertImageFromPicker(id: BlockId): Promise<void> {
    const file = await pickImageFile();
    if (file) await insertUploadedImage(id, file);
  }

  function onPaste(id: BlockId, event: ClipboardEvent, _view: EditorView): boolean {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    const imageItem = [...clipboard.items].find((it) => it.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        void insertUploadedImage(id, file);
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
  // And before a server op reads the text (`./outline-registry.ts#flushTyping`, B-192).
  onCleanup(registerTypingFlush(() => flushPendingEdit()));
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
      // `/image` (B-99) was delegated here and fell through `runCommand`'s default: no chooser.
      if (commandId === "block.insertImage") {
        if (id) void insertImageFromPicker(id as BlockId);
        return;
      }
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
    commitOps: (batch) => {
      const clock = clockSig();
      const prepared = clock && !props.readOnly && prepareExternalBatch(batch, editorTree(), clock);
      if (!prepared) return false;
      runStructural(prepared);
      return true;
    },
    linkAtCaret: () => linkAtCaret(surface.content(), surface.head()),
  });
  // Mounted, not only focused: a date picked from a chip is written with nothing here edited or
  // selected, and still belongs in this tree's undo history (B-142). Released in the cleanup below.
  registerEditorHost(editorHost);
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
      case "block.copySelection":
        // Registered but never implemented (B-84): Cmd+C on a selection copied nothing at all.
        void navigator.clipboard?.writeText(selectionMarkdown(tree, sel.ids, visibleIds()));
        return;
      case "block.cutSelection": {
        // B-245: Copy's exact text, then Delete's exact ops as ONE commit, so one Cmd+Z undoes the
        // whole cut. The delete waits for the clipboard write (see `cutToClipboard`), so it builds
        // against the tree as it is then, keeping only blocks that still exist.
        const text = selectionMarkdown(tree, sel.ids, visibleIds());
        void cutToClipboard(text, navigator.clipboard, () => {
          const now = editorTree();
          const live = sel.ids.filter((id) => now.byId.has(id));
          commit(deleteSelectedBlocks(now, live, clock).ops, now, "structure", null, null);
          if (selection() === sel) setSelection(null);
        });
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
    if (readOnly()) return;
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
    if (readOnly()) {
      readOnlyNotice.show();
      return;
    }
    const clock = clockSig();
    const block = editorTree().byId.get(id);
    if (!clock || !block) return;
    commitStep(toggleDone(block, clock));
  }

  /** Shift+click, from a row or from a `[[page]]` link inside one (`BlockRowView.tsx` explains why
   * Shift and not something else). The shelf wants a block's page id as well as its own, and this
   * tree is the last place that knows it for free — every row here belongs to `props.pageId`.
   * Except a row drawn inside an `{{embed}}`, which lives on another page and names it (B-215). */
  function onShelfOpen(target: NavigateTarget): void {
    openOnShelf(
      target.kind === "page"
        ? target
        : { kind: "block", id: target.id, pageId: target.pageId ?? props.pageId },
    );
  }

  function onSelectClick(id: BlockId): void {
    // No block selection on a locked page: every block command — including the task commands,
    // which write through the store rather than this tree — targets the selection published in
    // the command context, so a selection here would be a way around the lock.
    if (readOnly()) return;
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

  /**
   * A page that exists and has no blocks — made by an agent's `page.create`, or emptied by deleting
   * every block (a journal day included) — rendered zero rows and gave nowhere to type (B-410; B-75
   * fixed only pages created from the UI). Only once the fetch has answered "no blocks", so a page
   * still loading does not flash it; never while zoomed or filtered, where "no rows" means
   * something else.
   */
  const emptyPage = createMemo(
    () =>
      !readOnly() &&
      effectiveRoot() === undefined &&
      !props.filter &&
      treeResource()?.blocks.length === 0 &&
      visibleIds().length === 0,
  );
  function startFirstBlock(): void {
    const clock = clockSig();
    if (readOnly() || !clock) return;
    const id = newId();
    const place = { pageId: props.pageId, parentId: null, order: orderBetween(null, null) };
    const payload = { kind: "block.create", place, content: "", createdAt: Date.now() } as const;
    runStructural({
      ops: [makeOp(clock.next(), clock.device, id, payload)],
      focus: { id, caret: { at: "end" } },
    });
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
        classList={{ "vr-outliner-readonly": readOnly() }}
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
                        findMatch={
                          findMatches()
                            ? (findMatches()?.has(id) ?? false) || editingId() === id
                            : undefined
                        }
                        surfaceHost={(el) => surfaceHostRef(el, id)}
                        onEnterEdit={(offset) => {
                          if (!readOnly()) attachEditing(id, { offset });
                          // A click that ended a drag-select of text is copying, not editing.
                          else if (window.getSelection()?.isCollapsed !== false) {
                            readOnlyNotice.show();
                          }
                        }}
                        readOnly={readOnly()}
                        onReadOnlyRefused={() => readOnlyNotice.show()}
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
                          if (!readOnly() && editingId() !== id && !inSelection)
                            attachEditing(id, { at: "end" });
                          // A locked block takes no caret, so the context would stay with whatever
                          // another tree holds — a selection in another journal day — and the menu
                          // over this block offered Delete/Move for that unseen one. Release it:
                          // the menu here is the timestamps and nothing else.
                          else if (readOnly()) requestEditingEnd();
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
                        remoteChange={
                          remoteOffer()?.id === id
                            ? {
                                other: remoteOffer()?.text ?? "",
                                onTake: takeRemoteOffer,
                                onKeep: () => setRemoteOffer(null),
                              }
                            : undefined
                        }
                      />
                    )}
                  </Show>
                )}
              </Show>
            );
          }}
        </For>
        <Show when={emptyPage()}>
          <button type="button" class="vr-row vr-empty-start" onClick={startFirstBlock}>
            <span class="vr-bullet-wrap" aria-hidden="true">
              <span class="vr-bullet">
                <span class="vr-bullet-dot" />
              </span>
            </span>
            <span class="vr-row-main">
              <span class="vr-content vr-empty-start-label">Start typing…</span>
            </span>
          </button>
        </Show>
      </div>
      <readOnlyNotice.View />
    </>
  );
}
