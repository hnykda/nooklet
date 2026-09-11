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

import type {
  EditorHost,
  EditorSelection,
  LinkAtCaret,
  ReplaceRangeSpec,
} from "../commands/hosts/editor-host.js";
import type { CommandContext, WhenContext } from "../commands/types.js";

let active: EditorHost | null = null;

/** Called by the focused `BlockTree`; pass `null` on blur/unmount. */
export function setActiveEditorHost(host: EditorHost | null): void {
  active = host;
}

const NOOP_HOST: EditorHost = {
  getSelection: () => null,
  replaceRange: () => {},
  runStructuralCommand: () => {},
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
  runStructuralCommand: (id, ctx) => activeEditorHost().runStructuralCommand(id, ctx),
  getLinkAtCaret: () => activeEditorHost().getLinkAtCaret(),
};

/** A live host view over one editor surface. `BlockTree` builds this once and registers it. */
export interface EditorHostBacking {
  currentId(): string | null;
  content(): string;
  head(): number;
  anchor(): number;
  setText(id: string, text: string, caret: number | { anchor: number; head: number }): void;
  runStructural(id: string, commandId: string, ctx: CommandContext): void | Promise<void>;
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
      const blockId = backing.currentId();
      if (blockId === null) return;
      return backing.runStructural(blockId, id, ctx);
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
export type EditorContextSnapshot = Omit<ContextBase, "store" | "platform" | "mobile">;

let snapshotFn: (() => EditorContextSnapshot) | null = null;

/** Called by the focused `BlockTree`; pass `null` on blur/unmount. */
export function setActiveContextSnapshot(fn: (() => EditorContextSnapshot) | null): void {
  snapshotFn = fn;
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
  return snapshotFn?.() ?? NOTHING_FOCUSED;
}

/** Assemble the full base a `CommandProvider` consumer needs. */
export function buildContextBase(
  store: ContextBase["store"],
  platform: WhenContext["platform"],
  mobile: boolean,
): ContextBase {
  return { ...activeContextSnapshot(), store, platform, mobile };
}
