/**
 * Types for the command system, transcribed from docs/spec/commands-and-keymap.md's "Interfaces"
 * section. Field names/shapes MUST match the spec exactly (task item 1) — do not rename or
 * reshape anything here without updating the spec first.
 *
 * A few fields reference types this package does not own (the editor's `Surface`, the future
 * storage/sync spec's `Store`). Those are declared here as narrow placeholders documented at the
 * point of use; see `hosts/` for the seams this package actually depends on at runtime.
 */
import type { ApplyOpsResult, Op, TaskMarker } from "@nooklet/core";

// ── `Surface` placeholder ──────────────────────────────────────────────────────────────────────
// research/04-editor.md §3.3 / ADR 006 own the real `Surface` type (a mounted CodeMirror view
// plus caret/geometry helpers). commands/ never calls anything on it directly — it only threads
// the reference through `CommandContext` for commands whose `run()` is implemented by the editor
// (see hosts/editor-host.ts) or for future callers. Kept as `unknown` on purpose.
export type Surface = unknown;

// ── Command registry ────────────────────────────────────────────────────────────────────────────

export interface WhenContext {
  editorFocused: boolean;
  blockSelected: boolean;
  hasSelection: boolean;
  selectionCount: number;
  isTask: boolean;
  isCollapsed: boolean;
  hasChildren: boolean;
  atLineStart: boolean;
  atLineEnd: boolean;
  onFirstVisualLine: boolean;
  onLastVisualLine: boolean;
  caretInLink: boolean;
  popupOpen: boolean;
  composing: boolean;
  zoomed: boolean;
  /** The main view is one page's outline (a page route, zoomed or not). */
  pageView: boolean;
  platform: "mac" | "windows" | "linux" | "ios" | "android";
  mobile: boolean;
}

/** The canonical, closed set of `WhenContext` field names and their JS-primitive type (R7), used
 * to reject a bare identifier used on a non-boolean field at compile time (R6's last sentence). */
export const WHEN_CONTEXT_FIELD_TYPES: Readonly<
  Record<keyof WhenContext, "boolean" | "number" | "string">
> = {
  editorFocused: "boolean",
  blockSelected: "boolean",
  hasSelection: "boolean",
  selectionCount: "number",
  isTask: "boolean",
  isCollapsed: "boolean",
  hasChildren: "boolean",
  atLineStart: "boolean",
  atLineEnd: "boolean",
  onFirstVisualLine: "boolean",
  onLastVisualLine: "boolean",
  caretInLink: "boolean",
  popupOpen: "boolean",
  composing: "boolean",
  zoomed: "boolean",
  pageView: "boolean",
  platform: "string",
  mobile: "boolean",
};

/** A default, all-false/zero `WhenContext` — a safe base for tests and for building a partial
 * context with `{ ...DEFAULT_WHEN_CONTEXT, editorFocused: true }`. */
export const DEFAULT_WHEN_CONTEXT: WhenContext = {
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
  platform: "mac",
  mobile: false,
};

/** Minimal placeholder for the future storage/sync spec's `Store` (R "Interfaces": "read/write
 * handle over blocks/pages ... defined by the storage/sync spec, not here"). This package only
 * needs the slice below (task-state property writes); see `hosts/store.ts` for the documented
 * seam and a fake used by this package's own tests. The integrator supplies a real implementation
 * that wraps `data/store.ts#applyOps` with correctly-clocked ops (HLC/device id) — commands/ never
 * constructs an `Op` id itself. */
export interface BlockTaskSnapshot {
  marker: TaskMarker | null;
  scheduled?: string;
  deadline?: string;
  repeat?: string;
}

export interface BlockPropsWrite {
  blockId: string;
  props: Record<string, string | null>;
}

export interface Store {
  /** The current task-relevant properties of one block, or `undefined` if it doesn't exist.
   * `task.cycle`/`task.toggleDone`/`task.setMarkerDone` need this to apply R35's repeat-aware
   * completion rule, which depends on the block's *current* `repeat`/`scheduled`/`deadline`, not
   * just the `isTask`/`isCollapsed`-style booleans `WhenContext` carries. */
  getBlockTaskState(blockId: string): Promise<BlockTaskSnapshot | undefined>;
  /** Set one reserved block property (`marker`, `priority`, `scheduled`, `deadline`, `repeat`,
   * `done`) or an arbitrary property key, as one atomic write. `null` clears the property. */
  setBlockProp(blockId: string, key: string, value: string | null): Promise<void>;
  /** Set several block properties as a single atomic transaction (R35's "stamp `done` AND set
   * `marker`" / "advance `scheduled`/`deadline` AND reset `marker`" both need this). */
  setBlockProps(blockId: string, props: Record<string, string | null>): Promise<void>;
  /** Several blocks' properties as ONE write — one undo step, anchored on the first block (a marker
   * command over a multi-selection, B-346). `setBlockProps` once per block is one Cmd/Ctrl+Z each. */
  setPropsOfBlocks(writes: ReadonlyArray<BlockPropsWrite>): Promise<void>;
  /** Escape hatch mirroring `data/store.ts#applyOps` today, for callers that already have
   * fully-formed ops (correct id/hlc/device). */
  applyOps(ops: Op[]): Promise<ApplyOpsResult>;
}

export interface Command {
  /** "<area>.<verb>", see R2. */
  id: string;
  /** Palette/menu display text. */
  title: string;
  /** Longer help text, palette secondary line. */
  description?: string;
  /** Palette grouping, see R3. MAY differ from the id's area segment. */
  category: string;
  /** Grammar in § B; absent = always enabled. */
  when?: string;
  /** Resolved-form tokens, see R15. Always present as an object; either/both platform key MAY
   * be absent, meaning no default shortcut on that platform (R1). */
  defaultKeys: { mac?: string; other?: string };
  /** Icon-set key, palette/menu/toolbar glyph. */
  icon?: string;
  /** ADR 015 §2.4: whether `ui_run` (the live-UI-control MCP tool) may invoke this command at all,
   * independent of the calling token's own scopes and this command's own `when` clause (both are
   * still checked). Default-allow (`true` when absent) rather than a hand-maintained allowlist
   * that has to be kept in sync with every future command — core sets it `false` only for commands
   * that act outside the document model entirely (a hypothetical future `app.quit`, a
   * factory-reset), of which there are none in the v1 registry today. */
  remoteInvocable?: boolean;
  /** R1a: `run()` needs `ctx.args` to do anything (an agent primitive such as `nav.openPage`,
   * which takes a page). Surfaces that invoke a command with no payload — the palette, menus —
   * MUST NOT list it; `ctx.exec(id, args)`, the live-UI channel and a `keybindings.json` row with
   * `args` still reach it. Listed, such a command was a row that did nothing when chosen (B-105). */
  requiresArgs?: boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext extends WhenContext {
  focusedBlockId: string | null;
  selectedBlockIds: string[];
  /** Non-null iff `editorFocused`. */
  surface: Surface | null;
  store: Store;
  /** Run another command by id. */
  exec: (commandId: string, args?: unknown) => Promise<void>;
  /** This invocation's payload, if any. */
  args?: unknown;
}

// ── `when` clauses ─────────────────────────────────────────────────────────────────────────────

export type WhenLiteral = string | boolean | number;

export type WhenNode =
  | { t: "or"; left: WhenNode; right: WhenNode }
  | { t: "and"; left: WhenNode; right: WhenNode }
  | { t: "not"; node: WhenNode }
  | { t: "eq" | "neq"; ident: string; literal: WhenLiteral }
  | { t: "ident"; name: string };

// ── Keybindings ────────────────────────────────────────────────────────────────────────────────

/** e.g. "Cmd+Enter", "Mod+K Mod+S" (chord). */
export type KeyToken = string;

export interface KeybindingEntry {
  key: KeyToken | { mac?: KeyToken; other?: KeyToken };
  /** Command id, or "-<id>" to remove (R66). */
  command: string;
  when?: string;
  args?: unknown;
}

export type KeybindingsFile = KeybindingEntry[];

export type BindingSource = "base" | "secondary" | "user";

/** One row of the assembled runtime keymap (R64). */
export interface ResolvedBinding {
  /** Platform-resolved, e.g. "Cmd+Enter". */
  key: string;
  command: string;
  when?: string;
  source: BindingSource;
  /** Load order, used by R12's resolution walk. */
  order: number;
  args?: unknown;
}

export interface KeymapConflict {
  key: string;
  /** >= 2 command ids sharing this key, R67. */
  commands: string[];
}

// ── Palette / slash menu / autocomplete ───────────────────────────────────────────────────────

export type PaletteMode = "mixed" | "commands" | "pages" | "tags";

export interface PaletteState {
  mode: PaletteMode;
  query: string;
}

export interface RankedResult<T> {
  item: T;
  /** fuzzysort score; null = no match (excluded). */
  score: number | null;
  /** Infinity if not in the MRU (R73). */
  mruIndex: number;
}

export interface MruEntry {
  kind: "command" | "page";
  id: string;
  lastUsedAt: number;
}

export interface SlashItem {
  label: string;
  command: string;
  keywords: string[];
}

export interface ToolbarButton {
  icon: string;
  command: string;
}

export type CaretSpec =
  | { at: "start" | "end" }
  | { offset: number }
  | { goalX: number; line: "first" | "last" };
