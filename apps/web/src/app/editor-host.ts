/**
 * The bridge between the command system's `EditorHost` seam and whichever editor surface is
 * actually focused right now.
 *
 * `EditorHost` cannot be a plain singleton implementation the way `Store`/`PageSource` can: it is
 * inherently about "the block the user is editing at this moment", which belongs to whichever
 * `BlockTree` currently owns the shared CodeMirror surface (a journal stream renders one per day,
 * so several exist at once and at most one is focused). So `BlockTree` publishes itself here on
 * focus and clears on blur/unmount, and the command system reads through `activeEditorHost()`.
 *
 * When nothing is focused every method is a safe no-op returning `null`, which is exactly what
 * the commands' own `when` clauses already expect (`editorFocused` is false, so editor-scoped
 * commands do not fire at all — this is just belt and braces).
 */

import { createSignal } from "solid-js";
import type {
  EditorHost,
  EditorSelection,
  LinkAtCaret,
  OpBatch,
  ReplaceRangeSpec,
} from "../commands/hosts/editor-host.js";
import type { CommandContext, WhenContext } from "../commands/types.js";
import { requestEditingEnd } from "../editor/focus-request.js";
import { runOnOutlines } from "../editor/outline-registry.js";

let active: EditorHost | null = null;
/** The host that was active last, kept after its session ends, for undo/redo only. */
let recent: EditorHost | null = null;
/** Every mounted tree's host, focused or not, for `commitOps` (B-142). */
const mounted = new Set<EditorHost>();

/** Called by the focused `BlockTree`; pass `null` on blur/unmount. */
export function setActiveEditorHost(host: EditorHost | null): void {
  active = host;
  if (host) recent = host;
}

/** Called by a `BlockTree` once, at mount: its host may take a command's op batch even while
 * nothing in it is edited or selected (`commitThroughEditor`). */
export function registerEditorHost(host: EditorHost): void {
  mounted.add(host);
}

/** Called by a `BlockTree` that unmounts: its history goes with it, so it must stop being the
 * undo target (and the active host, if it still is). */
export function releaseEditorHost(host: EditorHost): void {
  mounted.delete(host);
  if (recent === host) recent = null;
  if (active === host) active = null;
}

/**
 * `EditorHost.commitOps` for a command that does not know which tree shows its block: the active
 * tree, else the one whose session ended last, else any mounted tree — the first that takes it.
 *
 * Not just the active host. A date picked from a chip (B-142) is written with nothing edited or
 * selected, so no tree is active, and the write went past every history: Cmd/Ctrl+Z could not take
 * it back. The tree that takes a batch becomes the undo target (`historyEditorHost`), because the
 * step just landed in ITS history — undo going to a tree that never saw the write does nothing.
 * A tree only takes a batch for a block it shows (`../editor/external-batch.ts`), so trying every
 * mounted one never lands a write on the wrong page.
 */
function commitThroughEditor(batch: OpBatch): boolean {
  const candidates = new Set<EditorHost>();
  if (active) candidates.add(active);
  if (recent) candidates.add(recent);
  for (const host of mounted) candidates.add(host);
  for (const host of candidates) {
    if (!host.commitOps(batch)) continue;
    // Another tree took it while a session stands in the active one — a block left selected with
    // Escape, which clicks elsewhere do not clear. `historyEditorHost` prefers `active`, so
    // Cmd/Ctrl+Z took back that tree's last step and left the date (B-281). End the standing
    // session, as a click on a locked tree does, so the undo goes where the step went. A batch that
    // moves the caret needs none of this: attaching the editor makes its tree the active one.
    if (active !== null && active !== host && !batch.focus) requestEditingEnd();
    recent = host;
    return true;
  }
  return false;
}

/** Focus is in a plain text field (search, page title, journal draft), not in the outliner. */
function typingInOtherField(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * Where Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z go: the active host, or else the tree whose editing or
 * selection session ended most recently.
 *
 * A tree withdraws as the active host the moment nothing in it is edited or selected, so the
 * context snapshot stops describing a session that is over. Undo used to be withdrawn with it,
 * and the moments that end a session are exactly the ones you undo: deleting a block selection
 * (it clears the selection), clicking away, an undo that leaves nothing focused. Cmd+Z did
 * nothing, and the tree's history kept the step until the next time a block there was edited,
 * where the undo then fired unexpectedly (B-241). The history lives as long as the tree, so the
 * fallback does too (`releaseEditorHost`). It does not take a keystroke meant for a text field
 * outside the outliner.
 */
export function historyEditorHost(): EditorHost {
  if (active) return active;
  if (recent && !typingInOtherField()) return recent;
  return NOOP_HOST;
}

const NOOP_HOST: EditorHost = {
  getSelection: () => null,
  replaceRange: () => {},
  // Nothing is focused, but "Collapse all"/"Expand all" still have a target — the outline(s) on
  // screen. Every other structural command stays a no-op here (B-97, `../editor/outline-registry.ts`).
  runStructuralCommand: (id) => {
    runOnOutlines(id);
  },
  commitOps: () => false,
  getLinkAtCaret: () => null,
};

/** The `EditorHost` the command system should use right now. Never null, so callers need no
 * guards; when nothing is focused it is an inert no-op host. */
export function activeEditorHost(): EditorHost {
  return active ?? NOOP_HOST;
}

/**
 * A STABLE `EditorHost` that forwards every call to whichever host is active at that moment.
 *
 * `activeEditorHost()` returns a snapshot of the host as of the instant it is called. Anything
 * built once at startup — the command registry, the slash menu, the autocomplete popups — must
 * hold THIS instead, or it captures the inert no-op host that exists before any `BlockTree` has
 * taken focus and keeps it forever. That is precisely what happened: `CommandLayer` did
 * `const editor = activeEditorHost()` at setup, so `getSelection()` always returned null and the
 * slash menu, `[[`/`#`/`((` autocomplete and the formatting shortcuts silently did nothing,
 * despite every one of them being unit-tested against a fake host.
 */
export const liveEditorHost: EditorHost = {
  getSelection: () => activeEditorHost().getSelection(),
  replaceRange: (spec) => activeEditorHost().replaceRange(spec),
  runStructuralCommand: (id, ctx) =>
    (id === "edit.undo" || id === "edit.redo"
      ? historyEditorHost()
      : activeEditorHost()
    ).runStructuralCommand(id, ctx),
  commitOps: (batch) => commitThroughEditor(batch),
  getLinkAtCaret: () => activeEditorHost().getLinkAtCaret(),
};

/** A live host view over one editor surface. `BlockTree` builds this once and registers it. */
export interface EditorHostBacking {
  currentId(): string | null;
  content(): string;
  head(): number;
  anchor(): number;
  setText(id: string, text: string, caret: number | { anchor: number; head: number }): void;
  /** `id` is null when no block is being edited — a selection-mode command arriving through the
   *  global dispatcher, which the tree resolves against its own selection. */
  runStructural(id: string | null, commandId: string, ctx: CommandContext): void | Promise<void>;
  /** `EditorHost.commitOps`: the tree commits the batch through its own history, or says no. */
  commitOps(batch: OpBatch): boolean;
  linkAtCaret(): LinkAtCaret | null;
}

export function createEditorHost(backing: EditorHostBacking): EditorHost {
  return {
    getSelection(): EditorSelection | null {
      const blockId = backing.currentId();
      if (blockId === null) return null;
      const a = backing.anchor();
      const h = backing.head();
      return {
        blockId,
        content: backing.content(),
        start: Math.min(a, h),
        end: Math.max(a, h),
      };
    },

    replaceRange(spec: ReplaceRangeSpec): void {
      const blockId = backing.currentId();
      if (blockId === null) return;
      const content = backing.content();
      const next = content.slice(0, spec.from) + spec.text + content.slice(spec.to);
      // `caretOffset` is relative to `from` (see ReplaceRangeSpec), so it has to be rebased onto
      // the new content before the surface sees it — treating it as absolute would drop the caret
      // `from` characters early on every insertion that is not at position 0.
      const rel = spec.caretOffset ?? spec.text.length;
      const caret =
        typeof rel === "number"
          ? spec.from + rel
          : { anchor: spec.from + rel.anchor, head: spec.from + rel.head };
      backing.setText(blockId, next, caret);
    },

    runStructuralCommand(id: string, ctx: CommandContext): void | Promise<void> {
      // No early return on a null id: after Escape the surface is detached but a selection stands,
      // and `block.editSelected` / `block.deleteSelected` / Alt+arrows arrive here with the
      // keydown already preventDefault'ed by the dispatcher. Returning early dropped them on the
      // floor — Enter from selection mode did nothing (B-44). The tree decides what a null id means.
      return backing.runStructural(backing.currentId(), id, ctx);
    },

    commitOps(batch: OpBatch): boolean {
      return backing.commitOps(batch);
    },

    getLinkAtCaret(): LinkAtCaret | null {
      return backing.linkAtCaret();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The live context snapshot
// ---------------------------------------------------------------------------------------------

/** Everything a `CommandContext` needs except `exec`/`args`, which the provider adds. */
export type ContextBase = Omit<CommandContext, "exec" | "args">;

/** The parts only the focused editor can know. The app layer supplies `store` and `platform`. */
export type EditorContextSnapshot = Omit<ContextBase, "store" | "platform" | "mobile" | "pageView">;

// A signal, not a plain variable: `activeContextSnapshot()` is read inside memos (the mobile
// keyboard toolbar's `visible`, for one), and a plain `let` gave them nothing to track — the memo
// ran once at mount, saw nothing focused, and never ran again, so the toolbar never appeared on a
// phone at all (B-70).
const [snapshotFn, setSnapshotFn] = createSignal<(() => EditorContextSnapshot) | null>(null);

/** Called by the focused `BlockTree`; pass `null` on blur/unmount. */
export function setActiveContextSnapshot(fn: (() => EditorContextSnapshot) | null): void {
  setSnapshotFn(() => fn);
}

const NOTHING_FOCUSED: EditorContextSnapshot = {
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
  focusedBlockId: null,
  selectedBlockIds: [],
  surface: null,
};

/** The editor half of the command context, or an all-false snapshot when nothing is focused —
 * which is exactly what makes every editor-scoped `when` clause evaluate false, so those commands
 * simply do not fire outside the editor. */
export function activeContextSnapshot(): EditorContextSnapshot {
  return snapshotFn()?.() ?? NOTHING_FOCUSED;
}

/** Assemble the full base a `CommandProvider` consumer needs. */
export function buildContextBase(
  store: ContextBase["store"],
  platform: WhenContext["platform"],
  mobile: boolean,
  pageView = false,
): ContextBase {
  return { ...activeContextSnapshot(), store, platform, mobile, pageView };
}
