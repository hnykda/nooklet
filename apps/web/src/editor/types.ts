/**
 * Types for the editor's pure, DOM-free "tree + cursor + key -> ops" seam (`commands.ts`) and the
 * small in-memory tree representation it operates over (`tree.ts`). Nothing in this file imports
 * Solid, CodeMirror, or the DOM: it is deliberately usable from a plain vitest test with no
 * jsdom/testing-library, which is the highest-value testing decision for this package (see
 * `commands.test.ts`).
 *
 * `EditableBlock` is a projection of `@nooklet/core`'s `BlockRow` (via `BlockTreeNode`, the shape
 * `usePageTree`/`useJournalStream` already return) down to the fields the keyboard contract
 * (`docs/spec/commands-and-keymap.md`) needs to reason about. `BlockTree.tsx` builds one from the
 * live data seam; tests build one by hand.
 */
import type { Properties, TaskMarker } from "@nooklet/core";

export type BlockId = string;

export interface EditableBlock {
  id: BlockId;
  parentId: BlockId | null;
  /** Fractional sibling order key (`@nooklet/core`'s `order.ts`). */
  order: string;
  /** Markdown text, no bullet/marker/priority/property lines (matches `Block.content`). */
  content: string;
  marker: TaskMarker | null;
  priority: "A" | "B" | "C" | null;
  collapsed: boolean;
  /** Reconstructed `"YYYY-MM-DD"` / `"YYYY-MM-DD HH:MM"` (ADR 011 canonical form), or null. */
  scheduled: string | null;
  deadline: string | null;
  /** `"<n><unit>"` or `"<n><unit> from done"` (ADR 011), or null. */
  repeat: string | null;
  /** Epoch ms, or null. */
  doneAt: number | null;
  /** Generic `block_prop` properties (`BlockTreeNode.properties`): `list:: number` (OUT-17, read by
   * `numbering.ts#isNumbered`), `author:: …`, and so on — never the reserved keys above. While a
   * block is edited, the editable ones are written into the buffer as `key:: value` lines and split
   * back out on flush (`@nooklet/core`'s `block-text.ts`). */
  properties: Readonly<Properties>;
}

/** An immutable snapshot of one page's (or subtree's) blocks, indexed for O(1) parent/child/order
 * lookups. Every command in `commands.ts` takes one of these plus a target id and returns new ops
 * — it never mutates the snapshot it was given (batch commands clone internally, `tree.ts`). */
export interface EditorTree {
  pageId: string;
  byId: Map<BlockId, EditableBlock>;
  /** Child ids of `parentId` (or of `null` for page-root blocks), ascending by `order` then `id`
   * (tie-break matches `data/tree.ts#buildBlockTree` / `compareOrder`). */
  childrenOf: Map<BlockId | null, BlockId[]>;
}

/** One visible row (`research/04-editor.md` §3.1's `Row`, extended with the block id it renders). */
export interface Row {
  id: BlockId;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/** Where to put the caret after a structural command re-attaches the surface to a block
 * (`research/04-editor.md` §3.3's `CaretSpec`). */
export type CaretSpec =
  | { at: "start" | "end" }
  | { offset: number }
  | { goalX: number; line: "first" | "last" };

export interface FocusChange {
  id: BlockId;
  caret: CaretSpec;
}

/** A monotonic local clock a pure command uses to stamp ops — injected so tests can supply a
 * deterministic fake instead of `@nooklet/core`'s real `Hlc` (`editor/clock.ts` in production). */
export interface Clock {
  next(): string;
  readonly device: string;
  /** Make every later `next()` newer than `hlc` (`@nooklet/core`'s `Hlc.receive`). Optional: only
   * the real editor clock has it, for typing that must win over a version seen from elsewhere
   * (B-192). */
  receive?(hlc: string): void;
}
